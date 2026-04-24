const path = require('path');
const fs = require('fs');
const { parseStoredToggles } = require('../services/documentWorkflowMailRules');
const { parseId, stepForward } = require('../domain/document/WorkflowStep');

function safeAsciiFilename(name) {
  return String(name || 'file')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
}

function createDocumentWorkflowController(deps) {
  const {
    db,
    documentModel,
    documentRepository,
    unitRepository,
    userRepository,
    uploadsRoot,
    hasAnyRole,
    canAccessDocument,
    mailSend,
    baseUrl,
    workflowService,
  } = deps;

  function actorName(req) {
    return req.user && (req.user.fullName || req.user.fullname || req.user.email)
      ? String(req.user.fullName || req.user.fullname || req.user.email)
      : null;
  }

  function canManageDocument(req) {
    return hasAnyRole(req, ['module_manager', 'master_admin', 'admin']);
  }

  function canDeleteDocument(req) {
    return hasAnyRole(req, ['master_admin', 'admin']);
  }

  function history(documentId, step, action, note, req) {
    documentModel.addHistory(documentId, {
      step,
      action,
      note: note || null,
      actorId: req.user && req.user.id ? req.user.id : null,
      actorName: actorName(req),
    });
  }

  function ensureWorkflowActive(record, res) {
    const status = String((record && record.status) || '').trim().toLowerCase();
    if (status === 'aborted') {
      res.status(400).json({ message: 'Hồ sơ đã dừng quy trình (aborted), không thể thao tác thêm.' });
      return false;
    }
    return true;
  }

  function safeSendMail(payload) {
    if (typeof mailSend !== 'function') return;
    Promise.resolve(mailSend(payload)).catch(() => {});
  }

  function dedupeEmails(arr) {
    return Array.from(new Set((arr || []).filter(Boolean)));
  }

  function getEmailTogglesMerged() {
    return parseStoredToggles(getModuleSetting('email_notification_toggles', ''));
  }

  function getMasterAdminEmails() {
    try {
      const rows = db.prepare(`SELECT email, role FROM users WHERE trim(COALESCE(email,'')) <> ''`).all();
      return Array.from(
        new Set(
          (rows || [])
            .filter((r) => {
              const parts = String(r.role || '')
                .toLowerCase()
                .split(/[,\s;|]+/)
                .map((x) => x.trim())
                .filter(Boolean);
              return parts.includes('master_admin') || parts.includes('admin');
            })
            .map((r) => String(r.email || '').trim())
            .filter(Boolean)
        )
      );
    } catch (_) {
      return [];
    }
  }

  /**
   * Gửi mail theo cấu hình email_notification_toggles + email_enabled.
   * buildPayload(evToggle) trả về { to?, cc?, subject, text } hoặc null.
   */
  function sendWorkflowNotification(eventKey, buildPayload) {
    if (String(getModuleSetting('email_enabled', '1')) !== '1') return;
    if (typeof mailSend !== 'function') return;
    const toggles = getEmailTogglesMerged();
    const ev = toggles[eventKey];
    if (!ev || ev.enabled === false) return;
    const payload = buildPayload(ev, toggles);
    if (!payload) return;
    let to = dedupeEmails(payload.to);
    let cc = dedupeEmails(payload.cc);
    cc = cc.filter((e) => !to.includes(e));
    if (!to.length && cc.length) {
      to = cc;
      cc = [];
    }
    if (!to.length) return;
    safeSendMail({
      to,
      cc: cc.length ? cc : undefined,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
  }

  function documentLink(documentId) {
    const base = String(baseUrl || process.env.BASE_URL || '').replace(/\/$/, '');
    return base
      ? `${base}/quy-trinh-van-ban-noi-bo.html?documentId=${documentId}`
      : `/quy-trinh-van-ban-noi-bo.html?documentId=${documentId}`;
  }

  function docTypeLabel(code) {
    const map = {
      quy_che: 'Quy chế',
      quy_dinh: 'Quy định',
      noi_quy: 'Nội quy',
      huong_dan: 'Hướng dẫn',
    };
    const key = String(code || '').trim().toLowerCase();
    return map[key] || code || 'N/A';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function composeFormalEmail(opts) {
    const o = opts || {};
    const greeting = String(o.greeting || 'Kính gửi Quý đối tác,').trim();
    const closing = String(o.closing || 'Trân trọng,').trim();
    const signature = String(o.signature || 'Hệ thống quản lý quy trình ban hành văn bản nội bộ').trim();
    const paragraphs = (o.paragraphs || []).map((x) => String(x || '').trim()).filter(Boolean);
    const details = (o.details || []).map((x) => String(x || '').trim()).filter(Boolean);
    const link = String(o.link || '').trim();
    const linkLabel = String(o.linkLabel || 'Xem chi tiết tại:').trim();

    let text = `${greeting}\n\n`;
    if (paragraphs.length) text += `${paragraphs.join('\n\n')}\n\n`;
    if (details.length) text += `${details.map((x) => `- ${x}`).join('\n')}\n\n`;
    if (link) text += `${linkLabel}\n${link}\n\n`;
    text += `${closing}\n${signature}`;

    const htmlParagraphs = paragraphs.map((p) => `<p style="margin:0 0 12px 0;">${escapeHtml(p)}</p>`).join('');
    const htmlDetails = details.length
      ? `<ul style="margin:0 0 12px 18px;padding:0;">${details
          .map((d) => `<li style="margin:0 0 6px 0;">${escapeHtml(d)}</li>`)
          .join('')}</ul>`
      : '';
    const htmlLink = link
      ? `<p style="margin:0 0 6px 0;">${escapeHtml(linkLabel)}</p><p style="margin:0 0 12px 0;"><a href="${escapeHtml(
          link
        )}" target="_blank" rel="noopener noreferrer">${escapeHtml(link)}</a></p>`
      : '';
    const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;">
<p style="margin:0 0 12px 0;">${escapeHtml(greeting)}</p>
${htmlParagraphs}
${htmlDetails}
${htmlLink}
<p style="margin:0;">${escapeHtml(closing)}<br/><strong>${escapeHtml(signature)}</strong></p>
</div>`;

    return { text, html };
  }

  function getUserEmailById(userId) {
    if (!userId) return null;
    try {
      const row = db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId);
      return row && row.email ? String(row.email).trim() : null;
    } catch (_) {
      return null;
    }
  }

  function getRoleEmails(role) {
    try {
      const want = String(role || '')
        .toLowerCase()
        .trim();
      const rows = db.prepare(`SELECT email, role FROM users WHERE trim(COALESCE(email,'')) <> ''`).all();
      return Array.from(
        new Set(
          (rows || [])
            .filter((r) =>
              String(r.role || '')
                .toLowerCase()
                .split(/[,\s;|]+/)
                .map((x) => x.trim())
                .some((x) => x === want)
            )
            .map((r) => String(r.email || '').trim())
            .filter(Boolean)
        )
      );
    } catch (_) {
      return [];
    }
  }

  function getAllUnitEmails() {
    try {
      const rows = db.prepare(`SELECT email FROM users WHERE trim(COALESCE(email,'')) <> ''`).all();
      return Array.from(new Set((rows || []).map((r) => String(r.email || '').trim()).filter(Boolean)));
    } catch (_) {
      return [];
    }
  }

  function getModuleManagerEmails() {
    try {
      const rows = db
        .prepare(`SELECT email, role FROM users WHERE trim(COALESCE(email,'')) <> ''`)
        .all();
      return Array.from(
        new Set(
          (rows || [])
            .filter((r) =>
              String(r.role || "")
                .toLowerCase()
                .split(/[,\s;|]+/)
                .map((x) => x.trim())
                .filter(Boolean)
                .includes("module_manager")
            )
            .map((r) => String(r.email || "").trim())
            .filter(Boolean)
        )
      );
    } catch (_) {
      return [];
    }
  }

  function getModuleSetting(key, fallback) {
    try {
      const row = db.prepare(`SELECT setting_value FROM module_settings WHERE setting_key = ?`).get(String(key || ''));
      return row && row.setting_value != null ? String(row.setting_value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveFiles(documentId, step, files, category, uploadedBy) {
    const ids = [];
    for (const f of files || []) {
      const relPath = `/uploads/documents/${documentId}/step_${step}/${f.filename}`;
      ids.push(
        documentModel.addAttachment(documentId, {
          step,
          category: category || null,
          originalName: String((f && f.originalname) || '').trim() || 'file',
          storedName: f.filename,
          mimeType: f.mimetype || null,
          fileSize: Number(f.size || 0),
          filePath: relPath,
          uploadedBy: uploadedBy || null,
        })
      );
    }
    return ids;
  }

  function getUnits(req, res) {
    try {
      const rows = unitRepository
        ? unitRepository.listActive()
        : db.prepare(`SELECT id, code, name FROM units WHERE active = 1 ORDER BY name`).all();
      return res.json({ ok: true, data: rows });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không tải được danh sách đơn vị.' });
    }
  }

  function getAssignableUsers(req, res) {
    try {
      const rows = userRepository
        ? userRepository.listAssignableUsers()
        : db
            .prepare(
              `SELECT id, email, fullname, role
               FROM users
               WHERE COALESCE(is_active, CASE WHEN COALESCE(is_banned,0)=1 THEN 0 ELSE 1 END) = 1
               ORDER BY fullname COLLATE NOCASE, email COLLATE NOCASE`
            )
            .all();
      return res.json({ ok: true, data: rows });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không tải được danh sách người dùng.' });
    }
  }

  function getDashboardStats(req, res) {
    try {
      const stats = documentRepository
        ? documentRepository.getDashboardStats()
        : documentModel.getDashboardStats();
      return res.json({ ok: true, data: stats });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không tải được thống kê dashboard.' });
    }
  }

  function createDocument(req, res) {
    try {
      const result = workflowService
        ? workflowService.createDocument({
            body: req.body || {},
            user: req.user || {},
            req,
          })
        : { ok: false, status: 500, message: 'Workflow service chưa được cấu hình.' };
      if (!result.ok) {
        return res.status(result.status || 400).json({ message: result.message || 'Không tạo được hồ sơ.' });
      }
      return res.status(201).json({ ok: true, data: result.data });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không tạo được hồ sơ.' });
    }
  }

  function getDocuments(req, res) {
    try {
      const result = workflowService
        ? workflowService.getDocuments({ query: req.query || {}, req })
        : null;
      if (result && result.ok) return res.json(result);
      return res.status(500).json({ message: 'Workflow service chưa được cấu hình.' });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không tải được danh sách hồ sơ.' });
    }
  }

  function getDocumentDetail(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const result = workflowService
        ? workflowService.getDocumentDetail({ documentId, req })
        : null;
      if (result && result.ok) return res.json(result);
      if (result && !result.ok) {
        return res.status(result.status || 400).json({ message: result.message || 'Không tải được chi tiết hồ sơ.' });
      }
      return res.status(500).json({ message: 'Workflow service chưa được cấu hình.' });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không tải được chi tiết hồ sơ.' });
    }
  }

  function updateDocumentGeneral(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!ensureWorkflowActive(record, res)) return;
      if (!canManageDocument(req)) {
        return res.status(403).json({ message: 'Chỉ Workflow Manager hoặc Master Admin được sửa hồ sơ trực tiếp.' });
      }
      const body = req.body || {};
      const docTypeRaw = body.docType || body.doc_type;
      const updated = documentModel.update(documentId, {
        title: body.title != null ? String(body.title).trim() : undefined,
        docType: docTypeRaw != null ? String(docTypeRaw).trim().toLowerCase() : undefined,
        reason: body.reason != null ? String(body.reason).slice(0, 5000) : undefined,
        proposalSummary: body.proposalSummary != null ? String(body.proposalSummary).slice(0, 8000) : undefined,
        legalBasis: body.legalBasis != null ? String(body.legalBasis).slice(0, 5000) : undefined,
        scope: body.scope != null ? String(body.scope).slice(0, 5000) : undefined,
        applicableSubjects: body.applicableSubjects != null ? String(body.applicableSubjects).slice(0, 5000) : undefined,
        mainContent: body.mainContent != null ? String(body.mainContent).slice(0, 8000) : undefined,
        executionClause: body.executionClause != null ? String(body.executionClause).slice(0, 5000) : undefined,
      });
      history(documentId, Number(updated.current_step || record.current_step || 1), 'document_general_updated', 'Cập nhật hồ sơ trực tiếp bởi quản trị module', req);
      return res.json({ ok: true, data: updated });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không cập nhật được hồ sơ.' });
    }
  }

  function deleteDocument(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!canDeleteDocument(req)) {
        return res.status(403).json({ message: 'Chỉ Master Admin hoặc Admin được xóa hồ sơ.' });
      }
      documentModel.softDeleteDocument(documentId);
      history(documentId, Number(record.current_step || 1), 'document_deleted', 'Xóa mềm hồ sơ (deleted_at)', req);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không xóa được hồ sơ.' });
    }
  }

  function abortDocument(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!canManageDocument(req)) {
        return res.status(403).json({ message: 'Chỉ Workflow Manager hoặc Master Admin được hủy quy trình.' });
      }
      const status = String(record.status || '').trim().toLowerCase();
      if (status === 'archived') {
        return res.status(400).json({ message: 'Hồ sơ đã lưu trữ, không thể hủy quy trình.' });
      }
      if (status === 'aborted') {
        return res.status(400).json({ message: 'Hồ sơ đã ở trạng thái dừng quy trình.' });
      }
      const reasonRaw = req.body && req.body.reason != null ? String(req.body.reason).trim() : '';
      const reason = reasonRaw ? reasonRaw.slice(0, 1000) : null;
      const updated = documentModel.update(documentId, {
        status: 'aborted',
      });
      history(
        documentId,
        Number(record.current_step || 1),
        'document_aborted',
        reason || `Dừng quy trình tại bước ${Number(record.current_step || 1)}.`,
        req
      );
      return res.json({ ok: true, data: updated });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không hủy được quy trình hồ sơ.' });
    }
  }

  function assignDocument(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const result = workflowService.assignDocument({
        documentId,
        body: req.body || {},
        req,
      });
      if (!result.ok) return res.status(result.status || 400).json({ message: result.message });
      return res.json({ ok: true, data: result.data });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không phân công được hồ sơ.' });
    }
  }

  function saveDraft(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const result = workflowService.saveDraft({
        documentId,
        body: req.body || {},
        req,
        files: req.files || [],
      });
      if (!result.ok) return res.status(result.status || 400).json({ message: result.message });
      return res.json({ ok: true, data: result.data, attachmentIds: result.attachmentIds || [] });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không lưu được dự thảo.' });
    }
  }

  function reviewDocument(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const result = workflowService.reviewDocument({
        documentId,
        body: req.body || {},
        req,
      });
      if (!result.ok) return res.status(result.status || 400).json({ message: result.message });
      return res.json({ ok: true, data: result.data });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không xử lý được thẩm định.' });
    }
  }

  function addFeedback(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const result = workflowService.addFeedback({
        documentId,
        body: req.body || {},
        req,
      });
      if (!result.ok) return res.status(result.status || 400).json({ message: result.message });
      return res.status(result.status || 201).json({ ok: true, data: result.data });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không thêm được góp ý.' });
    }
  }

  function finalizeDraft(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const result = workflowService.finalizeDraft({
        documentId,
        body: req.body || {},
        req,
        files: req.files || [],
      });
      if (!result.ok) return res.status(result.status || 400).json({ message: result.message });
      return res.json({ ok: true, data: result.data, attachmentIds: result.attachmentIds || [] });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không hoàn thiện được dự thảo.' });
    }
  }

  function submitDocument(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const result = workflowService.submitDocument({
        documentId,
        body: req.body || {},
        req,
        files: req.files || [],
      });
      if (!result.ok) return res.status(result.status || 400).json({ message: result.message });
      return res.json({ ok: true, data: result.data, attachmentIds: result.attachmentIds || [] });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không trình ký được hồ sơ.' });
    }
  }

  function publishDocument(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const result = workflowService.publishDocument({
        documentId,
        body: req.body || {},
        req,
        files: req.files || [],
      });
      if (!result.ok) return res.status(result.status || 400).json({ message: result.message });
      return res.json({ ok: true, data: result.data, attachmentIds: result.attachmentIds || [] });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không ban hành được văn bản.' });
    }
  }

  function archiveDocument(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const result = workflowService.archiveDocument({
        documentId,
        body: req.body || {},
        req,
      });
      if (!result.ok) return res.status(result.status || 400).json({ message: result.message });
      return res.json({ ok: true, data: result.data });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không lưu trữ được hồ sơ.' });
    }
  }

  function uploadAttachments(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentRepository
        ? documentRepository.findById(documentId)
        : documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!ensureWorkflowActive(record, res)) return;
      if (!canAccessDocument(req, record)) {
        return res.status(403).json({ message: 'Bạn không có quyền thao tác hồ sơ này.' });
      }
      if (!req.files || !req.files.length) return res.status(400).json({ message: 'Thiếu file upload.' });
      const step = Math.min(9, Math.max(1, parseInt(req.body && req.body.step, 10) || record.current_step || 1));
      const category = req.body && req.body.category != null ? String(req.body.category).slice(0, 80) : null;
      const ids = saveFiles(documentId, step, req.files, category, req.user.id);
      history(documentId, step, 'attachment_added', `Upload bổ sung ${ids.length} file`, req);
      return res.status(201).json({ ok: true, attachmentIds: ids });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không upload được file đính kèm.' });
    }
  }

  function downloadAttachment(req, res) {
    try {
      const attachmentId = parseId(req.params.id);
      if (!attachmentId) return res.status(400).json({ message: 'ID file không hợp lệ.' });
      const attachment = documentRepository
        ? documentRepository.findAttachmentWithDocument(attachmentId)
        : db
            .prepare(
              `SELECT a.*, d.proposer_id, d.assigned_to_id, d.assigned_unit_id, d.current_step
               FROM document_attachments a
               JOIN documents d ON d.id = a.document_id
               WHERE a.id = ?`
            )
            .get(attachmentId);
      if (!attachment) return res.status(404).json({ message: 'Không tìm thấy file đính kèm.' });
      if (!canAccessDocument(req, attachment)) {
        return res.status(403).json({ message: 'Bạn không có quyền tải file này.' });
      }
      const rel = String(attachment.file_path || '')
        .replace(/^\/+/, '')
        .replace(/^uploads\//, '');
      const fullPath = path.join(uploadsRoot, rel);
      const normalized = path.normalize(fullPath);
      const uploadsNormalized = path.normalize(uploadsRoot);
      if (!normalized.startsWith(uploadsNormalized) || !fs.existsSync(normalized)) {
        return res.status(404).json({ message: 'File không tồn tại trên máy chủ.' });
      }
      res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream');
      const downloadName = String(attachment.original_name || path.basename(normalized) || 'file').trim() || 'file';
      const encodedName = encodeURIComponent(downloadName);
      const asciiFallback = safeAsciiFilename(downloadName);
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`
      );
      return res.sendFile(normalized);
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không tải được file đính kèm.' });
    }
  }

  return {
    getUnits,
    getAssignableUsers,
    getDashboardStats,
    createDocument,
    getDocuments,
    getDocumentDetail,
    updateDocumentGeneral,
    deleteDocument,
    abortDocument,
    assignDocument,
    saveDraft,
    reviewDocument,
    addFeedback,
    finalizeDraft,
    submitDocument,
    publishDocument,
    archiveDocument,
    uploadAttachments,
    downloadAttachment,
  };
}

module.exports = {
  createDocumentWorkflowController,
};
