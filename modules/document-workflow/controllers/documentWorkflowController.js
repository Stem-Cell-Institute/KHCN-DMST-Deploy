'use strict';

const path = require('path');
const fs = require('fs');

const { WorkflowError } = require('../application/services/DocumentWorkflowService');

function parseId(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function safeAsciiFilename(name) {
  return String(name || 'file')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
}

function handleError(res, err, fallback) {
  if (err instanceof WorkflowError) {
    return res.status(err.status || 400).json({ message: err.message || fallback });
  }
  return res.status(500).json({ message: (err && err.message) || fallback });
}

/**
 * HTTP controller MONG - chi lam 3 viec:
 *   1. Parse req (params/body/files) + check role/access
 *   2. Goi application service
 *   3. Map ket qua thanh JSON response
 * Toan bo business logic (state transition, event, mail, history) da chuyen xuong service/handlers.
 */
function createDocumentWorkflowController(deps) {
  const {
    db,
    uploadsRoot,
    hasAnyRole,
    canAccessDocument,
    workflowService,
    unitRepository,
    userRepository,
  } = deps;

  function canManageDocument(req) {
    return hasAnyRole(req, ['module_manager', 'master_admin', 'admin']);
  }

  function canDeleteDocument(req) {
    return hasAnyRole(req, ['master_admin', 'admin']);
  }

  return {
    getUnits(_req, res) {
      try {
        return res.json({ ok: true, data: unitRepository.listActive() });
      } catch (e) {
        return handleError(res, e, 'Không tải được danh sách đơn vị.');
      }
    },

    getAssignableUsers(_req, res) {
      try {
        return res.json({ ok: true, data: userRepository.getAssignableUsers() });
      } catch (e) {
        return handleError(res, e, 'Không tải được danh sách người dùng.');
      }
    },

    getDashboardStats(_req, res) {
      try {
        return res.json({ ok: true, data: workflowService.getDashboardStats() });
      } catch (e) {
        return handleError(res, e, 'Không tải được thống kê dashboard.');
      }
    },

    createDocument(req, res) {
      try {
        const body = req.body || {};
        const record = workflowService.createDocument({
          title: body.title,
          docType: body.docType || body.doc_type,
          reason: body.reason,
          proposalSummary: body.proposalSummary,
          actor: req.user || {},
        });
        return res.status(201).json({ ok: true, data: record });
      } catch (e) {
        return handleError(res, e, 'Không tạo được hồ sơ.');
      }
    },

    getDocuments(req, res) {
      try {
        const result = workflowService.listDocuments({
          step: req.query.step,
          unitId: req.query.unitId,
          status: req.query.status,
          search: req.query.search,
          page: req.query.page,
          limit: req.query.limit,
        });
        const filtered = result.rows.filter((doc) => canAccessDocument(req, doc));
        return res.json({
          ok: true,
          data: filtered,
          pagination: { ...result.pagination, visible: filtered.length },
        });
      } catch (e) {
        return handleError(res, e, 'Không tải được danh sách hồ sơ.');
      }
    },

    getDocumentDetail(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        const detail = workflowService.getDocument(documentId);
        if (!detail) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
        if (!canAccessDocument(req, detail)) {
          return res.status(403).json({ message: 'Bạn không có quyền xem hồ sơ này.' });
        }
        return res.json({ ok: true, data: detail });
      } catch (e) {
        return handleError(res, e, 'Không tải được chi tiết hồ sơ.');
      }
    },

    updateDocumentGeneral(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        if (!canManageDocument(req)) {
          return res
            .status(403)
            .json({ message: 'Chỉ Module Manager hoặc Master Admin được sửa hồ sơ trực tiếp.' });
        }
        const updated = workflowService.updateGeneral({
          documentId,
          patch: req.body || {},
          actor: req.user || {},
        });
        return res.json({ ok: true, data: updated });
      } catch (e) {
        return handleError(res, e, 'Không cập nhật được hồ sơ.');
      }
    },

    deleteDocument(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        if (!canDeleteDocument(req)) {
          return res.status(403).json({ message: 'Chỉ Master Admin hoặc Admin được xóa hồ sơ.' });
        }
        workflowService.softDelete({ documentId, actor: req.user || {} });
        return res.json({ ok: true });
      } catch (e) {
        return handleError(res, e, 'Không xóa được hồ sơ.');
      }
    },

    abortDocument(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        if (!canManageDocument(req)) {
          return res
            .status(403)
            .json({ message: 'Chỉ Module Manager hoặc Master Admin được hủy quy trình.' });
        }
        const updated = workflowService.abortDocument({
          documentId,
          reason: req.body && req.body.reason,
          actor: req.user || {},
        });
        return res.json({ ok: true, data: updated });
      } catch (e) {
        return handleError(res, e, 'Không hủy được quy trình hồ sơ.');
      }
    },

    assignDocument(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        const updated = workflowService.assignDocument({
          documentId,
          unitId: parseId(req.body && req.body.unitId),
          assignedToId: parseId(req.body && req.body.assignedToId),
          assignedToName: req.body && req.body.assignedToName,
          deadline: req.body && req.body.deadline,
          actor: req.user || {},
        });
        return res.json({ ok: true, data: updated });
      } catch (e) {
        return handleError(res, e, 'Không phân công được hồ sơ.');
      }
    },

    saveDraft(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        const record = workflowService.getDocument(documentId);
        if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
        if (
          Number(record.assigned_to_id) !== Number(req.user.id) &&
          !hasAnyRole(req, ['admin', 'leader', 'module_manager', 'master_admin'])
        ) {
          return res
            .status(403)
            .json({ message: 'Chỉ người được phân công soạn thảo mới được thao tác.' });
        }
        const out = workflowService.saveDraft({
          documentId,
          body: req.body || {},
          files: req.files || [],
          actor: req.user || {},
        });
        return res.json({ ok: true, data: out.updated, attachmentIds: out.attachmentIds });
      } catch (e) {
        return handleError(res, e, 'Không lưu được dự thảo.');
      }
    },

    reviewDocument(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        const updated = workflowService.reviewDocument({
          documentId,
          action: req.body && req.body.action,
          comment: req.body && req.body.comment,
          actor: req.user || {},
        });
        return res.json({ ok: true, data: updated });
      } catch (e) {
        return handleError(res, e, 'Không xử lý được thẩm định.');
      }
    },

    addFeedback(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        const id = workflowService.addFeedback({
          documentId,
          content: req.body && req.body.content,
          actor: req.user || {},
        });
        return res.status(201).json({ ok: true, data: { id } });
      } catch (e) {
        return handleError(res, e, 'Không thêm được góp ý.');
      }
    },

    finalizeDraft(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        const record = workflowService.getDocument(documentId);
        if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
        if (
          Number(record.assigned_to_id) !== Number(req.user.id) &&
          !hasAnyRole(req, ['admin', 'leader', 'module_manager', 'master_admin'])
        ) {
          return res
            .status(403)
            .json({ message: 'Chỉ người được phân công soạn thảo mới được thao tác.' });
        }
        const out = workflowService.finalizeDraft({
          documentId,
          body: req.body || {},
          files: req.files || [],
          actor: req.user || {},
        });
        return res.json({ ok: true, data: out.updated, attachmentIds: out.attachmentIds });
      } catch (e) {
        return handleError(res, e, 'Không hoàn thiện được dự thảo.');
      }
    },

    submitDocument(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        const record = workflowService.getDocument(documentId);
        if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
        if (
          Number(record.assigned_to_id) !== Number(req.user.id) &&
          !hasAnyRole(req, ['admin', 'leader', 'module_manager', 'master_admin'])
        ) {
          return res
            .status(403)
            .json({ message: 'Chỉ người được phân công soạn thảo mới được thao tác.' });
        }
        const out = workflowService.submitDocument({
          documentId,
          submitNote: req.body && req.body.submitNote,
          files: req.files || [],
          actor: req.user || {},
        });
        return res.json({ ok: true, data: out.updated, attachmentIds: out.attachmentIds });
      } catch (e) {
        return handleError(res, e, 'Không trình ký được hồ sơ.');
      }
    },

    publishDocument(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        const out = workflowService.publishDocument({
          documentId,
          body: req.body || {},
          files: req.files || [],
          actor: req.user || {},
        });
        return res.json({ ok: true, data: out.updated, attachmentIds: out.attachmentIds });
      } catch (e) {
        return handleError(res, e, 'Không ban hành được văn bản.');
      }
    },

    archiveDocument(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        const updated = workflowService.archiveDocument({
          documentId,
          body: req.body || {},
          actor: req.user || {},
        });
        return res.json({ ok: true, data: updated });
      } catch (e) {
        return handleError(res, e, 'Không lưu trữ được hồ sơ.');
      }
    },

    uploadAttachments(req, res) {
      try {
        const documentId = parseId(req.params.id);
        if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
        const record = workflowService.getDocument(documentId);
        if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
        if (!canAccessDocument(req, record)) {
          return res.status(403).json({ message: 'Bạn không có quyền thao tác hồ sơ này.' });
        }
        if (!req.files || !req.files.length) {
          return res.status(400).json({ message: 'Thiếu file upload.' });
        }
        const ids = workflowService.uploadAttachments({
          documentId,
          step: req.body && req.body.step,
          category: req.body && req.body.category,
          files: req.files,
          actor: req.user || {},
        });
        return res.status(201).json({ ok: true, attachmentIds: ids });
      } catch (e) {
        return handleError(res, e, 'Không upload được file đính kèm.');
      }
    },

    downloadAttachment(req, res) {
      try {
        const attachmentId = parseId(req.params.id);
        if (!attachmentId) return res.status(400).json({ message: 'ID file không hợp lệ.' });
        const attachment = workflowService.findAttachmentWithContext(attachmentId);
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
        const downloadName =
          String(attachment.original_name || path.basename(normalized) || 'file').trim() || 'file';
        const encodedName = encodeURIComponent(downloadName);
        const asciiFallback = safeAsciiFilename(downloadName);
        res.setHeader(
          'Content-Disposition',
          `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`
        );
        return res.sendFile(normalized);
      } catch (e) {
        return handleError(res, e, 'Không tải được file đính kèm.');
      }
    },
  };
}

module.exports = {
  createDocumentWorkflowController,
};
