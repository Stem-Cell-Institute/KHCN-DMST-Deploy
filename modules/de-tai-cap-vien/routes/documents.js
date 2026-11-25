const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/db');
const config = require('../config/config');
const { getCriteriaByKey } = require('../services/auditService');

// Cấu hình Multer lưu file theo từng đề tài
const storage = multer.diskStorage({
  destination: async function (req, file, cb) {
    const projectId = req.params.projectId || req.body.project_id || 'temp';
    const project = await db.get('SELECT code FROM nckh_projects WHERE id = ?', [projectId]);
    const projectFolder = project ? project.code.replace(/[\/\\:]/g, '_') : `project_${projectId}`;
    
    const targetDir = path.join(config.UPLOAD_DIR, projectFolder);
    fs.mkdirSync(targetDir, { recursive: true });
    cb(null, targetDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E6);
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-\u00C0-\u1EF9]/g, '_');
    cb(null, `${basename}_${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// GET /api/documents/project/:projectId - Danh sách tài liệu của đề tài
router.get('/project/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const documents = await db.all(`
      SELECT * FROM nckh_documents 
      WHERE project_id = ? 
      ORDER BY stage ASC, id DESC
    `, [projectId]);

    res.json({ success: true, data: documents });
  } catch (err) {
    console.error('Error fetching documents:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/documents/upload/:projectId - Upload & cập nhật bổ sung tài liệu theo giai đoạn / danh mục (Tự động ghi đè gọn gàng nếu nộp lại cùng danh mục)
router.post('/upload/:projectId', upload.single('file'), async (req, res) => {
  try {
    const { projectId } = req.params;
    let { stage, doc_type, title, notes, replace_doc_id } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Chưa chọn file để tải lên' });
    }

    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [projectId]);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài' });
    }

    const userRole = req.user?.role || 'PHONG_KHCN';
    const crit = getCriteriaByKey(doc_type);

    // Kiểm tra phân quyền hợp lý theo thông lệ quản lý KHCN Việt Nam
    if (crit) {
      stage = crit.stage;
      if (!title || !title.trim()) {
        title = `${crit.name} - ${project.code}`;
      }
      if (!crit.allowed_upload_roles.includes(userRole)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(403).json({
          success: false,
          error: `Phân quyền: Văn bản "${crit.name}" thuộc trách nhiệm của [${crit.owner_label}]. Vai trò hiện tại (${req.user?.role_info?.short_name || userRole}) không có quyền tải lên mục này.`
        });
      }

      // Nếu mục này đã được P. KHCN xác thực bản chính (VERIFIED) thì chỉ P. KHCN hoặc Admin mới được phép ghi đè
      if (!['PHONG_KHCN', 'SUPER_ADMIN'].includes(userRole)) {
        const chk = await db.get('SELECT status FROM nckh_audit_checklist WHERE project_id = ? AND doc_key = ?', [projectId, crit.key]);
        if (chk && chk.status === 'VERIFIED') {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
          return res.status(403).json({
            success: false,
            error: `Văn bản "${crit.name}" đã được Phòng KH&CN đối chiếu và khóa lưu trữ bản chính. Vui lòng liên hệ Phòng KH&CN nếu cần cập nhật lại.`
          });
        }
      }
    }

    // Nếu là Chủ nhiệm đề tài, kiểm tra xem có đúng đề tài của mình không
    if (userRole === 'CHU_NHIEM' && req.user?.leader_name) {
      const pLeader = (project.leader_name || '').toLowerCase().trim();
      const uLeader = (req.user.leader_name || '').toLowerCase().trim();
      if (pLeader && uLeader && pLeader !== uLeader) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(403).json({
          success: false,
          error: `Phân quyền: Bạn đang đăng nhập với tư cách Chủ nhiệm "${req.user.leader_name}", không thể tải tài liệu vào đề tài của Chủ nhiệm "${project.leader_name}".`
        });
      }
    }

    const relativePath = path.relative(config.UPLOAD_DIR, req.file.path).replace(/\\/g, '/');
    const uploadedBy = req.user ? `${req.user.fullname} (${req.user.role_info?.short_name || userRole})` : 'Cán bộ P. KHCN';

    // Kiểm tra xem có bản ghi cũ cần thay thế không (tránh sinh bản ghi thừa khi nộp lại cùng 1 tiêu chí)
    let existingDoc = null;
    if (replace_doc_id) {
      existingDoc = await db.get('SELECT * FROM nckh_documents WHERE id = ? AND project_id = ?', [replace_doc_id, projectId]);
    } else if (doc_type && doc_type !== 'KHAC') {
      existingDoc = await db.get('SELECT * FROM nckh_documents WHERE project_id = ? AND doc_type = ? ORDER BY id DESC LIMIT 1', [projectId, doc_type]);
    }

    let documentId = null;
    if (existingDoc) {
      if (existingDoc.stored_path && existingDoc.stored_path !== relativePath) {
        const oldPath = path.join(config.UPLOAD_DIR, existingDoc.stored_path);
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch (_) {}
        }
      }
      await db.run(`
        UPDATE nckh_documents SET
          stage = ?,
          doc_type = ?,
          title = ?,
          file_name = ?,
          stored_path = ?,
          file_size = ?,
          mime_type = ?,
          uploaded_by = ?,
          notes = ?,
          uploaded_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        Number(stage) || 1,
        doc_type || 'KHAC',
        title || req.file.originalname,
        req.file.originalname,
        relativePath,
        req.file.size,
        req.file.mimetype,
        uploadedBy,
        notes || '',
        existingDoc.id
      ]);
      documentId = existingDoc.id;
    } else {
      const rs = await db.run(`
        INSERT INTO nckh_documents (
          project_id, stage, doc_type, title, file_name, stored_path,
          file_size, mime_type, uploaded_by, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        projectId,
        Number(stage) || 1,
        doc_type || 'KHAC',
        title || req.file.originalname,
        req.file.originalname,
        relativePath,
        req.file.size,
        req.file.mimetype,
        uploadedBy,
        notes || ''
      ]);
      documentId = rs.lastInsertRowid;
    }

    // Tự động đồng bộ sang bảng nckh_audit_checklist nếu doc_type là tiêu chí kiểm toán
    if (crit) {
      const now = new Date().toISOString();
      await db.run(`
        INSERT INTO nckh_audit_checklist (project_id, doc_key, status, verified_by, verified_at, notes, updated_at)
        VALUES (?, ?, 'UPLOADED', ?, ?, ?, ?)
        ON CONFLICT(project_id, doc_key) DO UPDATE SET
          status = CASE WHEN nckh_audit_checklist.status = 'VERIFIED' THEN 'VERIFIED' ELSE 'UPLOADED' END,
          verified_by = excluded.verified_by,
          verified_at = excluded.verified_at,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `, [
        projectId,
        crit.key,
        uploadedBy,
        now,
        notes || `Đã tải lên file: ${req.file.originalname}`,
        now
      ]);
    }

    res.json({
      success: true,
      message: existingDoc
        ? `Đã cập nhật và thay thế tệp văn bản "${title || req.file.originalname}" thành công!`
        : `Đã tải lên và lưu trữ văn bản "${title || req.file.originalname}" thành công!`,
      documentId,
      file_name: req.file.originalname,
      doc_type: doc_type || 'KHAC',
      stage: Number(stage) || 1
    });
  } catch (err) {
    console.error('Error uploading document:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/documents/:id/preview - Stream tài liệu để XEM TRỰC TIẾP TRÊN TRÌNH DUYỆT (Preview)
router.get('/:id/preview', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.get('SELECT * FROM nckh_documents WHERE id = ?', [id]);
    if (!doc) {
      return res.status(404).send('Không tìm thấy tài liệu');
    }

    const fullPath = path.join(config.UPLOAD_DIR, doc.stored_path);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).send('File không tồn tại trên máy chủ');
    }

    const ext = path.extname(doc.file_name).toLowerCase();
    let contentType = doc.mime_type || 'application/octet-stream';

    if (ext === '.pdf') {
      contentType = 'application/pdf';
    } else if (ext === '.png') {
      contentType = 'image/png';
    } else if (ext === '.jpg' || ext === '.jpeg') {
      contentType = 'image/jpeg';
    } else if (ext === '.txt') {
      contentType = 'text/plain; charset=utf-8';
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.file_name)}"`);

    const stream = fs.createReadStream(fullPath);
    stream.pipe(res);
  } catch (err) {
    console.error('Error previewing document:', err);
    res.status(500).send('Lỗi khi mở bản xem trước tài liệu: ' + err.message);
  }
});

// GET /api/documents/:id/download - Tải tài liệu về máy
router.get('/:id/download', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.get('SELECT * FROM nckh_documents WHERE id = ?', [id]);
    if (!doc) {
      return res.status(404).send('Không tìm thấy tài liệu');
    }

    const fullPath = path.join(config.UPLOAD_DIR, doc.stored_path);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).send('File không tồn tại');
    }

    res.download(fullPath, doc.file_name);
  } catch (err) {
    console.error('Error downloading document:', err);
    res.status(500).send('Lỗi khi tải file: ' + err.message);
  }
});

// PUT /api/documents/:id - Chỉnh sửa thông tin văn bản, đổi phân loại (Giai đoạn / Loại văn bản) khi tải nhầm, hoặc thay thế tệp đính kèm
router.put('/:id', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.get('SELECT * FROM nckh_documents WHERE id = ?', [id]);
    if (!doc) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
      return res.status(404).json({ success: false, error: 'Không tìm thấy văn bản cần chỉnh sửa' });
    }

    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [doc.project_id]);
    const userRole = req.user?.role || 'PHONG_KHCN';
    const isAdminOrKhcn = ['SUPER_ADMIN', 'PHONG_KHCN'].includes(userRole);

    // Kiểm tra quyền chỉnh sửa đối với mục hiện tại
    const oldCrit = getCriteriaByKey(doc.doc_type);
    if (!isAdminOrKhcn) {
      if (oldCrit && !oldCrit.allowed_upload_roles.includes(userRole)) {
        if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
        return res.status(403).json({
          success: false,
          error: `Phân quyền: Vai trò hiện tại không có thẩm quyền chỉnh sửa văn bản "${oldCrit.name}".`
        });
      }
      if (userRole === 'CHU_NHIEM' && req.user?.leader_name && project) {
        const pLeader = (project.leader_name || '').toLowerCase().trim();
        const uLeader = (req.user.leader_name || '').toLowerCase().trim();
        if (pLeader && uLeader && pLeader !== uLeader) {
          if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
          return res.status(403).json({
            success: false,
            error: 'Phân quyền: Bạn chỉ được phép chỉnh sửa văn bản của đề tài do mình làm Chủ nhiệm.'
          });
        }
      }
      if (oldCrit) {
        const chk = await db.get('SELECT status FROM nckh_audit_checklist WHERE project_id = ? AND doc_key = ?', [doc.project_id, oldCrit.key]);
        if (chk && chk.status === 'VERIFIED') {
          if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
          return res.status(403).json({
            success: false,
            error: 'Văn bản này đã được Phòng KH&CN đối chiếu và khóa lưu trữ bản chính. Vui lòng liên hệ Phòng KH&CN nếu cần điều chỉnh.'
          });
        }
      }
    }

    let newStage = Number(req.body.stage) || Number(doc.stage) || 1;
    const newDocType = req.body.doc_type || doc.doc_type || 'KHAC';
    const newCrit = getCriteriaByKey(newDocType);

    if (newCrit) {
      newStage = newCrit.stage;
      if (!isAdminOrKhcn && !newCrit.allowed_upload_roles.includes(userRole)) {
        if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
        return res.status(403).json({
          success: false,
          error: `Phân quyền: Bạn không có quyền chuyển văn bản sang mục "${newCrit.name}" (thuộc trách nhiệm của ${newCrit.owner_label}).`
        });
      }
    }

    const newTitle = (req.body.title && req.body.title.trim()) ? req.body.title.trim() : doc.title;
    const newNotes = req.body.notes !== undefined ? req.body.notes : doc.notes;
    const updatedBy = req.user ? `${req.user.fullname} (${req.user.role_info?.short_name || userRole})` : doc.uploaded_by;

    let newFileName = doc.file_name;
    let newStoredPath = doc.stored_path;
    let newFileSize = doc.file_size;
    let newMimeType = doc.mime_type;

    if (req.file) {
      const relPath = path.relative(config.UPLOAD_DIR, req.file.path).replace(/\\/g, '/');
      if (doc.stored_path && doc.stored_path !== relPath) {
        const oldFullPath = path.join(config.UPLOAD_DIR, doc.stored_path);
        if (fs.existsSync(oldFullPath)) {
          try { fs.unlinkSync(oldFullPath); } catch (_) {}
        }
      }
      newFileName = req.file.originalname;
      newStoredPath = relPath;
      newFileSize = req.file.size;
      newMimeType = req.file.mimetype;
    }

    // Nếu người dùng đổi sang một doc_type mới (không phải KHAC) mà mục đó đã có bản ghi khác, dọn bản ghi bị trùng ở mục đích
    if (newDocType !== 'KHAC' && newDocType !== doc.doc_type) {
      const targetConflicts = await db.all(
        'SELECT * FROM nckh_documents WHERE project_id = ? AND doc_type = ? AND id != ?',
        [doc.project_id, newDocType, doc.id]
      );
      for (const cDoc of targetConflicts) {
        if (cDoc.stored_path && cDoc.stored_path !== newStoredPath) {
          const cPath = path.join(config.UPLOAD_DIR, cDoc.stored_path);
          if (fs.existsSync(cPath)) {
            try { fs.unlinkSync(cPath); } catch (_) {}
          }
        }
        await db.run('DELETE FROM nckh_documents WHERE id = ?', [cDoc.id]);
      }
    }

    await db.run(`
      UPDATE nckh_documents SET
        stage = ?,
        doc_type = ?,
        title = ?,
        file_name = ?,
        stored_path = ?,
        file_size = ?,
        mime_type = ?,
        uploaded_by = ?,
        notes = ?,
        uploaded_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      newStage,
      newDocType,
      newTitle,
      newFileName,
      newStoredPath,
      newFileSize,
      newMimeType,
      updatedBy,
      newNotes,
      doc.id
    ]);

    // Nếu đã đổi từ doc_type cũ sang doc_type mới, làm sạch trạng thái checklist của doc_type cũ nếu không còn tệp nào
    if (doc.doc_type && doc.doc_type !== newDocType) {
      const remainingOld = await db.get(
        'SELECT COUNT(*) as cnt FROM nckh_documents WHERE project_id = ? AND doc_type = ?',
        [doc.project_id, doc.doc_type]
      );
      if (!remainingOld || remainingOld.cnt === 0) {
        await db.run('DELETE FROM nckh_audit_checklist WHERE project_id = ? AND doc_key = ?', [doc.project_id, doc.doc_type]);
      }
    }

    // Đồng bộ checklist cho doc_type mới
    if (newCrit) {
      const now = new Date().toISOString();
      await db.run(`
        INSERT INTO nckh_audit_checklist (project_id, doc_key, status, verified_by, verified_at, notes, updated_at)
        VALUES (?, ?, 'UPLOADED', ?, ?, ?, ?)
        ON CONFLICT(project_id, doc_key) DO UPDATE SET
          status = CASE WHEN nckh_audit_checklist.status = 'VERIFIED' THEN 'VERIFIED' ELSE 'UPLOADED' END,
          verified_by = excluded.verified_by,
          verified_at = excluded.verified_at,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `, [
        doc.project_id,
        newCrit.key,
        updatedBy,
        now,
        newNotes || `Đã cập nhật văn bản: ${newFileName}`,
        now
      ]);
    }

    res.json({
      success: true,
      message: 'Đã cập nhật thông tin và phân loại văn bản thành công!'
    });
  } catch (err) {
    console.error('Error updating document:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/documents/:id - Gỡ / Xóa tài liệu tải nhầm (Kèm đồng bộ lại trạng thái checklist về Chưa nộp)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.get('SELECT * FROM nckh_documents WHERE id = ?', [id]);
    if (!doc) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tài liệu' });
    }

    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [doc.project_id]);
    const userRole = req.user?.role || 'PHONG_KHCN';
    const isAdminOrKhcn = ['SUPER_ADMIN', 'PHONG_KHCN'].includes(userRole);
    const crit = getCriteriaByKey(doc.doc_type);

    if (!isAdminOrKhcn) {
      if (crit && !crit.allowed_upload_roles.includes(userRole)) {
        return res.status(403).json({
          success: false,
          error: 'Phân quyền: Vai trò hiện tại không có thẩm quyền gỡ bỏ văn bản này.'
        });
      }
      if (userRole === 'CHU_NHIEM' && req.user?.leader_name && project) {
        const pLeader = (project.leader_name || '').toLowerCase().trim();
        const uLeader = (req.user.leader_name || '').toLowerCase().trim();
        if (pLeader && uLeader && pLeader !== uLeader) {
          return res.status(403).json({
            success: false,
            error: 'Phân quyền: Bạn chỉ được phép gỡ bỏ văn bản của đề tài do mình làm Chủ nhiệm.'
          });
        }
      }
      if (crit) {
        const chk = await db.get('SELECT status FROM nckh_audit_checklist WHERE project_id = ? AND doc_key = ?', [doc.project_id, crit.key]);
        if (chk && chk.status === 'VERIFIED') {
          return res.status(403).json({
            success: false,
            error: 'Văn bản này đã được Phòng KH&CN duyệt lưu trữ bản chính. Chỉ Phòng KH&CN hoặc Admin mới có thể gỡ bỏ.'
          });
        }
      }
    }

    const fullPath = path.join(config.UPLOAD_DIR, doc.stored_path);
    if (fs.existsSync(fullPath)) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
    }

    await db.run('DELETE FROM nckh_documents WHERE id = ?', [id]);

    // Đồng bộ lại nckh_audit_checklist: nếu không còn tệp nào thuộc doc_type này thì xóa trạng thái UPLOADED/VERIFIED để trả về Chưa nộp
    if (doc.doc_type && doc.doc_type !== 'KHAC') {
      const remaining = await db.get(
        'SELECT COUNT(*) as cnt FROM nckh_documents WHERE project_id = ? AND doc_type = ?',
        [doc.project_id, doc.doc_type]
      );
      if (!remaining || remaining.cnt === 0) {
        await db.run('DELETE FROM nckh_audit_checklist WHERE project_id = ? AND doc_key = ?', [doc.project_id, doc.doc_type]);
      }
    }

    res.json({ success: true, message: 'Đã gỡ bỏ tệp văn bản và khôi phục trạng thái danh mục thành công!' });
  } catch (err) {
    console.error('Error deleting document:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
