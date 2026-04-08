const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { createConferenceEmailService } = require('../services/conferenceEmailService');
const { exportApprovalWord } = require('../services/conferenceWordExport');

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

function sanitizeOrig(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._\-\u00C0-\u024F]/g, '_')
    .slice(0, 180);
}

function relUpload(absPath) {
  const base = path.join(process.cwd(), 'uploads', 'conference');
  const rel = path.relative(process.cwd(), absPath).split(path.sep).join('/');
  if (rel && !rel.startsWith('..')) return rel;
  return `uploads/conference/${path.basename(absPath)}`;
}

function nextSubmissionCode(db) {
  const y = new Date().getFullYear();
  const prefix = `HNHT-${y}-`;
  const row = db
    .prepare('SELECT submission_code FROM conference_registrations WHERE submission_code LIKE ? ORDER BY submission_code DESC LIMIT 1')
    .get(`${prefix}%`);
  let n = 1;
  if (row && row.submission_code) {
    const tail = String(row.submission_code).slice(prefix.length);
    const parsed = parseInt(tail, 10);
    if (Number.isFinite(parsed)) n = parsed + 1;
  }
  return prefix + String(n).padStart(4, '0');
}

function isAdmin(user) {
  return (user.role || '').toLowerCase() === 'admin';
}
function isKhcn(user) {
  return isAdmin(user) || (user.role || '').toLowerCase() === 'phong_khcn';
}
function isDirectorUser(user, coopIsVienTruong) {
  const em = (user.email || '').trim().toLowerCase();
  return isAdmin(user) || (user.role || '').toLowerCase() === 'vien_truong' || !!coopIsVienTruong(em);
}

function canViewRegistration(req, row, coopIsVienTruong) {
  if (!row) return false;
  if (isAdmin(req.user)) return true;
  if (Number(row.submitted_by_user_id) === Number(req.user.id)) return true;
  if (isKhcn(req.user)) return true;
  if (isDirectorUser(req.user, coopIsVienTruong)) return true;
  return false;
}

function parseFundingItems(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  try {
    const j = JSON.parse(String(raw));
    return Array.isArray(j) ? j : [];
  } catch (_) {
    return [];
  }
}

function validateFullRegistration(row) {
  const errs = [];
  if (!String(row.unit || '').trim()) errs.push('Thiếu đơn vị');
  if (!String(row.conf_name || '').trim()) errs.push('Thiếu tên hội nghị');
  if (!String(row.conf_organizer || '').trim()) errs.push('Thiếu đơn vị tổ chức');
  if (!String(row.conf_start_date || '').trim() || !String(row.conf_end_date || '').trim()) errs.push('Thiếu ngày');
  const a = row.conf_start_date;
  const b = row.conf_end_date;
  if (a && b && String(a) > String(b)) errs.push('Ngày kết thúc phải sau ngày bắt đầu');
  if (!String(row.conf_location || '').trim()) errs.push('Thiếu địa điểm');
  if (!String(row.invitation_status || '').trim()) errs.push('Thiếu trạng thái thư mời');
  if (row.invitation_status === 'Đã có thư mời' && !String(row.invitation_file_path || '').trim()) {
    errs.push('Cần tải lên thư mời');
  }
  if (Number(row.has_paper) === 1) {
    if (!String(row.paper_title || '').trim()) errs.push('Thiếu tiêu đề bài');
    if (!String(row.paper_authors || '').trim()) errs.push('Thiếu tác giả');
    if (!String(row.paper_type || '').trim() || row.paper_type === 'Không có bài') errs.push('Thiếu hình thức bài');
    if (!String(row.paper_file_path || '').trim()) errs.push('Cần tải lên file bài báo/tóm tắt');
  }
  if (!String(row.purpose || '').trim()) errs.push('Thiếu mục đích');
  const ft = row.funding_type;
  if (ft && ft !== 'Tự túc hoàn toàn') {
    const amt = Number(row.funding_requested_vnd || 0);
    if (!(amt > 0)) errs.push('Số tiền đề nghị hỗ trợ phải lớn hơn 0');
    const items = parseFundingItems(row.funding_items);
    if (!items.length) errs.push('Cần ít nhất một khoản trong dự trù kinh phí');
  }
  return errs;
}

function auditInsert(db, registrationId, actorId, action, oldSt, newSt, comment, ip, ua) {
  db.prepare(
    `INSERT INTO conference_audit_log (registration_id, actor_user_id, action, old_status, new_status, comment, ip_address, user_agent)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(registrationId, actorId, action, oldSt || null, newSt || null, comment || null, ip || null, ua || null);
}

function rowToResponse(row) {
  if (!row) return null;
  const o = { ...row };
  if (o.funding_items && typeof o.funding_items === 'string') {
    try {
      o.funding_items_parsed = JSON.parse(o.funding_items);
    } catch (_) {
      o.funding_items_parsed = [];
    }
  }
  return o;
}

module.exports = function createConferenceRegistrationRouter(deps) {
  const { db, coopSendMail, coopBuildEmail, baseUrl, coopIsVienTruong } = deps;
  const uploadRoot = path.join(__dirname, '..', 'uploads', 'conference');
  fs.mkdirSync(uploadRoot, { recursive: true });

  const emails = createConferenceEmailService({
    db,
    sendMail: coopSendMail,
    buildEmail: coopBuildEmail,
    baseUrl: baseUrl || 'http://localhost:3000',
  });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadRoot),
    filename: (req, file, cb) => {
      const safe = sanitizeOrig(file.originalname);
      cb(null, `tmp_${req.user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}_${safe}`);
    },
  });

  const fileFilter = (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error('INVALID_FILE_TYPE'));
  };

  const uploadMix = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter,
  }).fields([
    { name: 'invitation_file', maxCount: 1 },
    { name: 'paper_file', maxCount: 1 },
  ]);

  const uploadEvidenceMw = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter,
  }).array('evidence_files', 5);

  const router = express.Router();

  function clientMeta(req) {
    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket.remoteAddress || '';
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 500);
    return { ip, ua };
  }

  function finalizeFile(oldAbs, submissionCode, fileType, originalName) {
    if (!oldAbs || !fs.existsSync(oldAbs)) return null;
    const ts = Date.now();
    const safe = sanitizeOrig(originalName);
    const baseName = `${submissionCode}_${fileType}_${ts}_${safe}`;
    const dest = path.join(uploadRoot, baseName);
    fs.renameSync(oldAbs, dest);
    return dest;
  }

  /** GET / — list */
  router.get('/', (req, res) => {
    try {
      const role = (req.user.role || '').toLowerCase();
      const mgr = role === 'admin' || role === 'phong_khcn';
      const { status, unit, from_date, to_date, search } = req.query;

      let sql = `SELECT r.*, u.fullname AS submitter_name, u.email AS submitter_email
        FROM conference_registrations r
        JOIN users u ON u.id = r.submitted_by_user_id
        WHERE r.status != 'cancelled'`;
      const params = [];
      if (!mgr) {
        sql += ' AND r.submitted_by_user_id = ?';
        params.push(req.user.id);
      }
      if (status) {
        sql += ' AND r.status = ?';
        params.push(String(status));
      }
      if (unit) {
        sql += ' AND lower(r.unit) LIKE ?';
        params.push(`%${String(unit).trim().toLowerCase()}%`);
      }
      if (from_date) {
        sql += ' AND r.conf_start_date >= ?';
        params.push(String(from_date).slice(0, 10));
      }
      if (to_date) {
        sql += ' AND r.conf_end_date <= ?';
        params.push(String(to_date).slice(0, 10));
      }
      if (search) {
        sql += ' AND (lower(r.conf_name) LIKE ? OR lower(r.submission_code) LIKE ?)';
        const q = `%${String(search).trim().toLowerCase()}%`;
        params.push(q, q);
      }
      sql += ' ORDER BY r.created_at DESC';
      const rows = db.prepare(sql).all(...params);
      return res.json({ list: rows.map(rowToResponse) });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** POST / — create draft */
  router.post('/', (req, res, next) => {
    uploadMix(req, res, (err) => {
      if (err) {
        if (err.message === 'INVALID_FILE_TYPE') return res.status(400).json({ message: 'Chỉ chấp nhận PDF, DOC, DOCX' });
        return next(err);
      }
      next();
    });
  }, (req, res) => {
    try {
      const b = req.body || {};
      const code = nextSubmissionCode(db);
      const uid = req.user.id;

      const unit = (b.unit || '').trim();
      const invitationStatus = (b.invitation_status || 'Chưa có thư mời').trim();
      const confType = (b.conf_type || 'Trong nước').trim();
      const fundingType = (b.funding_type || 'Tự túc hoàn toàn').trim();
      const hasPaper = b.has_paper === true || b.has_paper === '1' || b.has_paper === 'true' ? 1 : 0;
      const fundingItemsJson = (() => {
        const fi = b.funding_items;
        if (fi == null) return '[]';
        if (typeof fi === 'string') return fi || '[]';
        try {
          return JSON.stringify(fi);
        } catch (_) {
          return '[]';
        }
      })();
      const fundingReq = parseInt(b.funding_requested_vnd, 10);
      const fundingRequestedVnd = Number.isFinite(fundingReq) ? fundingReq : 0;

      let invitationPath = null;
      let paperPath = null;
      const files = req.files || {};
      if (files.invitation_file && files.invitation_file[0]) {
        const f = files.invitation_file[0];
        const dest = finalizeFile(f.path, code, 'invitation', f.originalname);
        invitationPath = dest ? relUpload(dest) : null;
      }
      if (files.paper_file && files.paper_file[0]) {
        const f = files.paper_file[0];
        const dest = finalizeFile(f.path, code, 'paper', f.originalname);
        paperPath = dest ? relUpload(dest) : null;
      }

      const ins = db
        .prepare(
          `INSERT INTO conference_registrations (
          submission_code, submitted_by_user_id, unit, research_group, job_title,
          conf_name, conf_type, conf_organizer, conf_start_date, conf_end_date, conf_location, conf_country, conf_website,
          invitation_status, invitation_file_path,
          has_paper, paper_title, paper_authors, paper_type, paper_abstract, paper_file_path,
          funding_type, funding_requested_vnd, funding_items, funding_note, purpose, status, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft', datetime('now'))`
        )
        .run(
          code,
          uid,
          unit,
          (b.research_group || '').trim() || null,
          (b.job_title || '').trim() || null,
          (b.conf_name || '').trim(),
          confType,
          (b.conf_organizer || '').trim(),
          String(b.conf_start_date || '').slice(0, 10),
          String(b.conf_end_date || '').slice(0, 10),
          (b.conf_location || '').trim(),
          (b.conf_country || '').trim() || null,
          (b.conf_website || '').trim() || null,
          invitationStatus,
          invitationPath,
          hasPaper,
          (b.paper_title || '').trim() || null,
          (b.paper_authors || '').trim() || null,
          (b.paper_type || '').trim() || null,
          (b.paper_abstract || '').trim() || null,
          paperPath,
          fundingType,
          fundingRequestedVnd,
          fundingItemsJson,
          (b.funding_note || '').trim() || null,
          (b.purpose || '').trim()
        );

      const id = ins.lastInsertRowid;
      const { ip, ua } = clientMeta(req);
      auditInsert(db, id, uid, 'created', null, 'draft', null, ip, ua);

      if (invitationPath) {
        db.prepare(
          `INSERT INTO conference_attachments (registration_id, file_type, original_name, stored_path, file_size_bytes, uploaded_by)
           VALUES (?,?,?,?,?,?)`
        ).run(
          id,
          'invitation',
          (files.invitation_file && files.invitation_file[0].originalname) || '',
          invitationPath,
          files.invitation_file && files.invitation_file[0].size,
          uid
        );
      }
      if (paperPath) {
        db.prepare(
          `INSERT INTO conference_attachments (registration_id, file_type, original_name, stored_path, file_size_bytes, uploaded_by)
           VALUES (?,?,?,?,?,?)`
        ).run(
          id,
          'paper',
          (files.paper_file && files.paper_file[0].originalname) || '',
          paperPath,
          files.paper_file && files.paper_file[0].size,
          uid
        );
      }

      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      return res.status(201).json(rowToResponse(row));
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** GET /:id */
  router.get('/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      if (!canViewRegistration(req, row, coopIsVienTruong)) return res.status(403).json({ message: 'Không có quyền' });
      const atts = db.prepare('SELECT * FROM conference_attachments WHERE registration_id = ? ORDER BY id ASC').all(id);
      const capabilities = {
        khcn_approve: isKhcn(req.user) && ['submitted', 'khcn_reviewing'].includes(row.status),
        khcn_reject: isKhcn(req.user) && ['submitted', 'khcn_reviewing'].includes(row.status),
        director_approve:
          isDirectorUser(req.user, coopIsVienTruong) && ['khcn_approved', 'director_reviewing'].includes(row.status),
        director_reject:
          isDirectorUser(req.user, coopIsVienTruong) && ['khcn_approved', 'director_reviewing'].includes(row.status),
        upload_evidence:
          Number(row.submitted_by_user_id) === Number(req.user.id) && row.status === 'director_approved',
      };
      return res.json({ data: rowToResponse(row), attachments: atts, capabilities });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** PATCH /:id */
  router.patch('/:id', (req, res, next) => {
    uploadMix(req, res, (err) => {
      if (err) {
        if (err.message === 'INVALID_FILE_TYPE') return res.status(400).json({ message: 'Chỉ chấp nhận PDF, DOC, DOCX' });
        return next(err);
      }
      next();
    });
  }, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      if (Number(row.submitted_by_user_id) !== Number(req.user.id)) return res.status(403).json({ message: 'Chỉ người nộp được sửa' });
      const allowedSt = ['draft', 'khcn_rejected', 'director_rejected'];
      if (!allowedSt.includes(row.status)) return res.status(400).json({ message: 'Không được sửa ở trạng thái hiện tại' });

      const b = req.body || {};
      const code = row.submission_code;
      const files = req.files || {};
      let invitationPath = row.invitation_file_path;
      let paperPath = row.paper_file_path;

      if (files.invitation_file && files.invitation_file[0]) {
        const f = files.invitation_file[0];
        const dest = finalizeFile(f.path, code, 'invitation', f.originalname);
        invitationPath = dest ? relUpload(dest) : invitationPath;
      }
      if (files.paper_file && files.paper_file[0]) {
        const f = files.paper_file[0];
        const dest = finalizeFile(f.path, code, 'paper', f.originalname);
        paperPath = dest ? relUpload(dest) : paperPath;
      }

      const hasPaper = b.has_paper !== undefined ? (b.has_paper === true || b.has_paper === '1' || b.has_paper === 'true' ? 1 : 0) : row.has_paper;

      const updates = [];
      const params = [];
      const set = (col, val) => {
        updates.push(`${col} = ?`);
        params.push(val);
      };

      if (b.unit !== undefined) set('unit', String(b.unit).trim());
      if (b.research_group !== undefined) set('research_group', String(b.research_group).trim() || null);
      if (b.job_title !== undefined) set('job_title', String(b.job_title).trim() || null);
      if (b.conf_name !== undefined) set('conf_name', String(b.conf_name).trim());
      if (b.conf_type !== undefined) set('conf_type', String(b.conf_type).trim());
      if (b.conf_organizer !== undefined) set('conf_organizer', String(b.conf_organizer).trim());
      if (b.conf_start_date !== undefined) set('conf_start_date', String(b.conf_start_date).slice(0, 10));
      if (b.conf_end_date !== undefined) set('conf_end_date', String(b.conf_end_date).slice(0, 10));
      if (b.conf_location !== undefined) set('conf_location', String(b.conf_location).trim());
      if (b.conf_country !== undefined) set('conf_country', String(b.conf_country).trim() || null);
      if (b.conf_website !== undefined) set('conf_website', String(b.conf_website).trim() || null);
      if (b.invitation_status !== undefined) set('invitation_status', String(b.invitation_status).trim());
      if (files.invitation_file && files.invitation_file[0]) set('invitation_file_path', invitationPath);
      if (b.has_paper !== undefined) set('has_paper', hasPaper);
      if (b.paper_title !== undefined) set('paper_title', String(b.paper_title).trim() || null);
      if (b.paper_authors !== undefined) set('paper_authors', String(b.paper_authors).trim() || null);
      if (b.paper_type !== undefined) set('paper_type', String(b.paper_type).trim() || null);
      if (b.paper_abstract !== undefined) set('paper_abstract', String(b.paper_abstract).trim() || null);
      if (files.paper_file && files.paper_file[0]) set('paper_file_path', paperPath);
      if (b.funding_type !== undefined) set('funding_type', String(b.funding_type).trim());
      if (b.funding_requested_vnd !== undefined) {
        const n = parseInt(b.funding_requested_vnd, 10);
        set('funding_requested_vnd', Number.isFinite(n) ? n : 0);
      }
      if (b.funding_items !== undefined) {
        const fi = typeof b.funding_items === 'string' ? b.funding_items : JSON.stringify(b.funding_items || []);
        set('funding_items', fi);
      }
      if (b.funding_note !== undefined) set('funding_note', String(b.funding_note).trim() || null);
      if (b.purpose !== undefined) set('purpose', String(b.purpose).trim());

      updates.push("updated_at = datetime('now')");
      params.push(id);

      if (updates.length > 1) {
        db.prepare(`UPDATE conference_registrations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }

      const { ip, ua } = clientMeta(req);
      auditInsert(db, id, req.user.id, 'updated', row.status, row.status, null, ip, ua);

      if (files.invitation_file && files.invitation_file[0] && invitationPath) {
        db.prepare(
          `INSERT INTO conference_attachments (registration_id, file_type, original_name, stored_path, file_size_bytes, uploaded_by)
           VALUES (?,?,?,?,?,?)`
        ).run(id, 'invitation', files.invitation_file[0].originalname, invitationPath, files.invitation_file[0].size, req.user.id);
      }
      if (files.paper_file && files.paper_file[0] && paperPath) {
        db.prepare(
          `INSERT INTO conference_attachments (registration_id, file_type, original_name, stored_path, file_size_bytes, uploaded_by)
           VALUES (?,?,?,?,?,?)`
        ).run(id, 'paper', files.paper_file[0].originalname, paperPath, files.paper_file[0].size, req.user.id);
      }

      const out = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      return res.json(rowToResponse(out));
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** DELETE /:id — cancel */
  router.delete('/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      if (Number(row.submitted_by_user_id) !== Number(req.user.id)) return res.status(403).json({ message: 'Chỉ người nộp được hủy' });
      if (!['draft', 'submitted'].includes(row.status)) return res.status(400).json({ message: 'Chỉ hủy khi nháp hoặc đã nộp chờ Phòng' });
      const { ip, ua } = clientMeta(req);
      const tx = db.transaction(() => {
        db.prepare(`UPDATE conference_registrations SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(id);
        auditInsert(db, id, req.user.id, 'cancelled', row.status, 'cancelled', null, ip, ua);
      });
      tx();
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** POST /:id/submit */
  router.post('/:id/submit', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      if (Number(row.submitted_by_user_id) !== Number(req.user.id)) return res.status(403).json({ message: 'Chỉ người nộp' });
      const from = row.status;
      if (!['draft', 'khcn_rejected', 'director_rejected'].includes(from)) {
        return res.status(400).json({ message: 'Trạng thái không cho phép nộp' });
      }
      const errs = validateFullRegistration(row);
      if (errs.length) return res.status(400).json({ message: errs.join('; ') });

      const { ip, ua } = clientMeta(req);
      const action = from === 'draft' ? 'submitted' : 'resubmitted';
      const tx = db.transaction(() => {
        db.prepare(`UPDATE conference_registrations SET status='submitted', updated_at=datetime('now') WHERE id=?`).run(id);
        auditInsert(db, id, req.user.id, action, from, 'submitted', null, ip, ua);
      });
      tx();

      const fresh = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      const submitter = db.prepare('SELECT id, email, fullname FROM users WHERE id = ?').get(req.user.id);
      emails.sendSubmissionNotification(fresh, submitter).catch(() => {});

      return res.json(rowToResponse(fresh));
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** POST /:id/khcn-approve */
  router.post('/:id/khcn-approve', (req, res) => {
    try {
      if (!isKhcn(req.user)) return res.status(403).json({ message: 'Không có quyền' });
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      if (!['submitted', 'khcn_reviewing'].includes(row.status)) return res.status(400).json({ message: 'Trạng thái không hợp lệ' });
      const comment = (req.body && req.body.comment) || '';
      const { ip, ua } = clientMeta(req);
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE conference_registrations SET status='khcn_approved', khcn_reviewer_id=?, khcn_reviewed_at=datetime('now'), khcn_comment=?, updated_at=datetime('now') WHERE id=?`
        ).run(req.user.id, comment || null, id);
        auditInsert(db, id, req.user.id, 'khcn_approved', row.status, 'khcn_approved', comment || null, ip, ua);
      });
      tx();
      const fresh = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      const submitter = db.prepare('SELECT id, email, fullname FROM users WHERE id = ?').get(row.submitted_by_user_id);
      emails.sendDirectorReviewRequest(fresh, submitter).catch(() => {});
      return res.json(rowToResponse(fresh));
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** POST /:id/khcn-reject */
  router.post('/:id/khcn-reject', (req, res) => {
    try {
      if (!isKhcn(req.user)) return res.status(403).json({ message: 'Không có quyền' });
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      if (!['submitted', 'khcn_reviewing'].includes(row.status)) return res.status(400).json({ message: 'Trạng thái không hợp lệ' });
      const comment = (req.body && req.body.comment) || '';
      if (!String(comment).trim()) return res.status(400).json({ message: 'Bắt buộc có lý do' });
      const { ip, ua } = clientMeta(req);
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE conference_registrations SET status='khcn_rejected', khcn_reviewer_id=?, khcn_reviewed_at=datetime('now'), khcn_comment=?, updated_at=datetime('now') WHERE id=?`
        ).run(req.user.id, comment, id);
        auditInsert(db, id, req.user.id, 'khcn_rejected', row.status, 'khcn_rejected', comment, ip, ua);
      });
      tx();
      const fresh = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      const submitter = db.prepare('SELECT id, email, fullname FROM users WHERE id = ?').get(row.submitted_by_user_id);
      emails.sendKhcnRejectedNotification(fresh, submitter, req.user, comment).catch(() => {});
      return res.json(rowToResponse(fresh));
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** POST /:id/director-approve */
  router.post('/:id/director-approve', (req, res) => {
    try {
      if (!isDirectorUser(req.user, coopIsVienTruong)) return res.status(403).json({ message: 'Không có quyền' });
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      if (!['khcn_approved', 'director_reviewing'].includes(row.status)) return res.status(400).json({ message: 'Trạng thái không hợp lệ' });
      const comment = (req.body && req.body.comment) || '';
      const { ip, ua } = clientMeta(req);
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE conference_registrations SET status='director_approved', director_reviewer_id=?, director_reviewed_at=datetime('now'), director_comment=?, updated_at=datetime('now') WHERE id=?`
        ).run(req.user.id, comment || null, id);
        auditInsert(db, id, req.user.id, 'director_approved', row.status, 'director_approved', comment || null, ip, ua);
      });
      tx();
      const fresh = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      const submitter = db.prepare('SELECT id, email, fullname FROM users WHERE id = ?').get(row.submitted_by_user_id);
      emails.sendDirectorApprovedNotification(fresh, submitter).catch(() => {});
      return res.json(rowToResponse(fresh));
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** POST /:id/director-reject */
  router.post('/:id/director-reject', (req, res) => {
    try {
      if (!isDirectorUser(req.user, coopIsVienTruong)) return res.status(403).json({ message: 'Không có quyền' });
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      if (!['khcn_approved', 'director_reviewing'].includes(row.status)) return res.status(400).json({ message: 'Trạng thái không hợp lệ' });
      const comment = (req.body && req.body.comment) || '';
      if (!String(comment).trim()) return res.status(400).json({ message: 'Bắt buộc có lý do' });
      const { ip, ua } = clientMeta(req);
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE conference_registrations SET status='director_rejected', director_reviewer_id=?, director_reviewed_at=datetime('now'), director_comment=?, updated_at=datetime('now') WHERE id=?`
        ).run(req.user.id, comment, id);
        auditInsert(db, id, req.user.id, 'director_rejected', row.status, 'director_rejected', comment, ip, ua);
      });
      tx();
      const fresh = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      const submitter = db.prepare('SELECT id, email, fullname FROM users WHERE id = ?').get(row.submitted_by_user_id);
      emails.sendDirectorRejectedNotification(fresh, submitter, comment).catch(() => {});
      return res.json(rowToResponse(fresh));
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** POST /:id/upload-evidence */
  router.post('/:id/upload-evidence', (req, res, next) => {
    uploadEvidenceMw(req, res, (err) => {
      if (err) {
        if (err.message === 'INVALID_FILE_TYPE') return res.status(400).json({ message: 'Chỉ chấp nhận PDF, DOC, DOCX' });
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'File quá 20MB' });
        return next(err);
      }
      next();
    });
  }, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      if (Number(row.submitted_by_user_id) !== Number(req.user.id)) return res.status(403).json({ message: 'Chỉ người nộp' });
      if (row.status !== 'director_approved') return res.status(400).json({ message: 'Chỉ nộp minh chứng khi đã được Viện trưởng phê duyệt' });
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ message: 'Cần ít nhất một file' });
      const evidenceNote = (req.body && req.body.evidence_note) || '';

      const code = row.submission_code;
      const { ip, ua } = clientMeta(req);
      const tx = db.transaction(() => {
        for (const f of files) {
          const dest = finalizeFile(f.path, code, 'evidence', f.originalname);
          const rel = dest ? relUpload(dest) : null;
          if (rel) {
            db.prepare(
              `INSERT INTO conference_attachments (registration_id, file_type, original_name, stored_path, file_size_bytes, uploaded_by)
               VALUES (?,?,?,?,?,?)`
            ).run(id, 'evidence', f.originalname, rel, f.size, req.user.id);
          }
        }
        db.prepare(
          `UPDATE conference_registrations SET status='completed', evidence_uploaded_at=datetime('now'), evidence_note=?, updated_at=datetime('now') WHERE id=?`
        ).run(evidenceNote || null, id);
        auditInsert(db, id, req.user.id, 'evidence_uploaded', row.status, 'completed', evidenceNote || null, ip, ua);
      });
      tx();

      const fresh = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      const submitter = db.prepare('SELECT id, email, fullname FROM users WHERE id = ?').get(req.user.id);
      emails.sendEvidenceUploadedNotification(fresh, submitter, files.length).catch(() => {});
      return res.json(rowToResponse(fresh));
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** GET /:id/export-word */
  router.get('/:id/export-word', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      if (!canViewRegistration(req, row, coopIsVienTruong)) return res.status(403).json({ message: 'Không có quyền' });
      if (!['director_approved', 'completed'].includes(row.status)) {
        return res.status(400).json({ message: 'Chỉ xuất Word sau khi Viện trưởng phê duyệt' });
      }
      const buf = await exportApprovalWord(db, id);
      const { ip, ua } = clientMeta(req);
      const tx = db.transaction(() => {
        auditInsert(db, id, req.user.id, 'word_exported', row.status, row.status, null, ip, ua);
      });
      tx();
      const fname = `${row.submission_code || 'HNHT'}-don-dang-ky.docx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}"`);
      return res.send(buf);
    } catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ message: 'Không tìm thấy' });
      if (e.code === 'TEMPLATE_MISSING') return res.status(500).json({ message: 'Thiếu file mẫu Word' });
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** GET /:id/audit-log */
  router.get('/:id/audit-log', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      if (!canViewRegistration(req, row, coopIsVienTruong)) return res.status(403).json({ message: 'Không có quyền' });
      const logs = db
        .prepare(
          `SELECT a.*, u.fullname AS actor_name
           FROM conference_audit_log a
           LEFT JOIN users u ON u.id = a.actor_user_id
           WHERE a.registration_id = ?
           ORDER BY a.id ASC`
        )
        .all(id);
      return res.json({ list: logs });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** GET /:id/attachments/:aid/file — download */
  router.get('/:id/attachments/:aid/file', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const aid = parseInt(req.params.aid, 10);
      const row = db.prepare('SELECT * FROM conference_registrations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      if (!canViewRegistration(req, row, coopIsVienTruong)) return res.status(403).json({ message: 'Không có quyền' });
      const att = db.prepare('SELECT * FROM conference_attachments WHERE id = ? AND registration_id = ?').get(aid, id);
      if (!att) return res.status(404).json({ message: 'Không có file' });
      const abs = path.isAbsolute(att.stored_path) ? att.stored_path : path.join(process.cwd(), att.stored_path.split('/').join(path.sep));
      if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File không tồn tại trên máy chủ' });
      res.download(abs, att.original_name || path.basename(abs));
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  return router;
};
