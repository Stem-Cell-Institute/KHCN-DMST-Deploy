'use strict';

const { EVENT_TYPES, createEvent } = require('../../domain/events');
const { stepForward, isWorkflowActive } = require('../../domain/WorkflowStep');

const ALLOWED_DOC_TYPES = ['quy_che', 'quy_dinh', 'noi_quy', 'huong_dan'];

/**
 * Application service - 1 file / 1 BC (Workflow).
 * Moi public method la 1 use-case, tra ve ket qua hoac throw WorkflowError.
 */
class WorkflowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createDocumentWorkflowService(deps) {
  const { documentRepository, userRepository, eventBus } = deps;

  function publish(type, payload, actor) {
    if (!eventBus) return;
    eventBus.publish(
      createEvent(type, payload, {
        actorId: actor && actor.id ? Number(actor.id) : null,
        actorName: actor && (actor.fullName || actor.fullname || actor.email) || null,
      })
    );
  }

  function addHistory(documentId, step, action, note, actor) {
    documentRepository.addHistory(documentId, {
      step,
      action,
      note: note || null,
      actorId: actor && actor.id ? actor.id : null,
      actorName:
        actor && (actor.fullName || actor.fullname || actor.email)
          ? String(actor.fullName || actor.fullname || actor.email)
          : null,
    });
  }

  function saveFiles(documentId, step, files, category, uploadedBy) {
    const ids = [];
    for (const f of files || []) {
      const relPath = `/uploads/documents/${documentId}/step_${step}/${f.filename}`;
      ids.push(
        documentRepository.addAttachment(documentId, {
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

  function ensureActive(record) {
    if (!isWorkflowActive(record && record.status)) {
      throw new WorkflowError(400, 'Hồ sơ đã dừng quy trình (aborted), không thể thao tác thêm.');
    }
  }

  function requireRecord(record) {
    if (!record) throw new WorkflowError(404, 'Không tìm thấy hồ sơ.');
    return record;
  }

  return {
    // ---- Queries ------------------------------------------------------------
    listDocuments(filters) {
      return documentRepository.findAll(filters || {});
    },
    getDocument(documentId) {
      const record = documentRepository.findById(documentId);
      if (!record) return null;
      return {
        ...record,
        attachments: documentRepository.getAttachments(documentId),
        feedback: documentRepository.getFeedback(documentId),
        history: documentRepository.getHistory(documentId),
      };
    },
    getDashboardStats() {
      return documentRepository.getDashboardStats();
    },

    // ---- Step 1 - Create ----------------------------------------------------
    createDocument({ title, docType, reason, proposalSummary, actor }) {
      const cleanTitle = String(title || '').trim();
      const cleanType = String(docType || '').trim().toLowerCase();
      if (!cleanTitle) throw new WorkflowError(400, 'Thiếu tiêu đề.');
      if (!ALLOWED_DOC_TYPES.includes(cleanType)) {
        throw new WorkflowError(400, 'Loại văn bản không hợp lệ.');
      }
      const record = documentRepository.create({
        title: cleanTitle,
        docType: cleanType,
        reason: reason != null ? String(reason).trim() : null,
        proposalSummary: proposalSummary != null ? String(proposalSummary).trim() : null,
        proposerId: actor && actor.id ? actor.id : null,
        proposerUnit:
          actor && (actor.unit || actor.department_id || actor.departmentId)
            ? String(actor.unit || actor.department_id || actor.departmentId)
            : null,
      });
      addHistory(record.id, 1, 'proposal_created', 'Khởi tạo đề xuất văn bản', actor);
      publish(
        EVENT_TYPES.DocumentCreated,
        { documentId: record.id, title: record.title, docType: record.doc_type },
        actor
      );
      return record;
    },

    // ---- Free-form general update (Module Manager / Master Admin) ----------
    updateGeneral({ documentId, patch, actor }) {
      const record = requireRecord(documentRepository.findById(documentId));
      ensureActive(record);
      const body = patch || {};
      const docTypeRaw = body.docType || body.doc_type;
      const updated = documentRepository.update(documentId, {
        title: body.title != null ? String(body.title).trim() : undefined,
        docType: docTypeRaw != null ? String(docTypeRaw).trim().toLowerCase() : undefined,
        reason: body.reason != null ? String(body.reason).slice(0, 5000) : undefined,
        proposalSummary:
          body.proposalSummary != null ? String(body.proposalSummary).slice(0, 8000) : undefined,
        legalBasis: body.legalBasis != null ? String(body.legalBasis).slice(0, 5000) : undefined,
        scope: body.scope != null ? String(body.scope).slice(0, 5000) : undefined,
        applicableSubjects:
          body.applicableSubjects != null ? String(body.applicableSubjects).slice(0, 5000) : undefined,
        mainContent: body.mainContent != null ? String(body.mainContent).slice(0, 8000) : undefined,
        executionClause:
          body.executionClause != null ? String(body.executionClause).slice(0, 5000) : undefined,
      });
      addHistory(
        documentId,
        Number(updated.current_step || record.current_step || 1),
        'document_general_updated',
        'Cập nhật hồ sơ trực tiếp bởi quản trị module',
        actor
      );
      return updated;
    },

    // ---- Soft delete --------------------------------------------------------
    softDelete({ documentId, actor }) {
      const record = requireRecord(documentRepository.findById(documentId));
      documentRepository.softDelete(documentId);
      addHistory(
        documentId,
        Number(record.current_step || 1),
        'document_deleted',
        'Xóa mềm hồ sơ (deleted_at)',
        actor
      );
    },

    // ---- Abort --------------------------------------------------------------
    abortDocument({ documentId, reason, actor }) {
      const record = requireRecord(documentRepository.findById(documentId));
      const status = String(record.status || '').trim().toLowerCase();
      if (status === 'archived') {
        throw new WorkflowError(400, 'Hồ sơ đã lưu trữ, không thể hủy quy trình.');
      }
      if (status === 'aborted') {
        throw new WorkflowError(400, 'Hồ sơ đã ở trạng thái dừng quy trình.');
      }
      const reasonRaw = reason != null ? String(reason).trim() : '';
      const note = reasonRaw ? reasonRaw.slice(0, 1000) : null;
      const updated = documentRepository.update(documentId, { status: 'aborted' });
      addHistory(
        documentId,
        Number(record.current_step || 1),
        'document_aborted',
        note || `Dừng quy trình tại bước ${Number(record.current_step || 1)}.`,
        actor
      );
      publish(EVENT_TYPES.DocumentAborted, { documentId, reason: note }, actor);
      return updated;
    },

    // ---- Step 2 - Assign ----------------------------------------------------
    assignDocument({ documentId, unitId, assignedToId, assignedToName, deadline, actor }) {
      const record = requireRecord(documentRepository.findById(documentId));
      ensureActive(record);
      let finalAssignedTo = Number(assignedToId) || null;
      if (!finalAssignedTo && assignedToName) {
        finalAssignedTo = userRepository.findIdByEmailOrName(assignedToName);
      }
      if (!Number(unitId) || !finalAssignedTo) {
        throw new WorkflowError(400, 'Thiếu unitId hoặc assignedToId.');
      }
      const nextStep = stepForward(record.current_step, 3);
      const updated = documentRepository.update(documentId, {
        assignedUnitId: Number(unitId),
        assignedToId: finalAssignedTo,
        assignmentDeadline: deadline != null ? String(deadline).slice(0, 10) : null,
        currentStep: nextStep,
      });
      addHistory(documentId, 2, 'draft_assigned', `Phân công soạn thảo user #${finalAssignedTo}`, actor);
      publish(
        EVENT_TYPES.DocumentAssigned,
        {
          documentId,
          title: updated.title || record.title || '',
          assignedToId: finalAssignedTo,
          deadline: updated.assignment_deadline || null,
        },
        actor
      );
      return updated;
    },

    // ---- Step 3 - Draft (tao du thao) --------------------------------------
    saveDraft({ documentId, body, files, actor }) {
      const record = requireRecord(documentRepository.findById(documentId));
      ensureActive(record);
      const b = body || {};
      const nextStep = stepForward(record.current_step, 4);
      const updated = documentRepository.update(documentId, {
        legalBasis: b.legalBasis != null ? String(b.legalBasis).slice(0, 5000) : null,
        scope: b.scope != null ? String(b.scope).slice(0, 5000) : null,
        applicableSubjects:
          b.applicableSubjects != null ? String(b.applicableSubjects).slice(0, 5000) : null,
        mainContent: b.mainContent != null ? String(b.mainContent).slice(0, 8000) : null,
        executionClause: b.executionClause != null ? String(b.executionClause).slice(0, 5000) : null,
        currentStep: nextStep,
      });
      const attachmentIds = saveFiles(documentId, 3, files, 'draft_v1', actor && actor.id);
      addHistory(documentId, 3, 'upload_draft', `Tải dự thảo lần 1 (${attachmentIds.length} file)`, actor);
      publish(
        EVENT_TYPES.DraftSaved,
        {
          documentId,
          title: updated.title || record.title || '',
          attachmentCount: attachmentIds.length,
        },
        actor
      );
      return { updated, attachmentIds };
    },

    // ---- Step 4 - Review ----------------------------------------------------
    reviewDocument({ documentId, action, comment, actor }) {
      const record = requireRecord(documentRepository.findById(documentId));
      ensureActive(record);
      const act = String(action || '').trim().toLowerCase();
      if (!['approve', 'reject'].includes(act)) {
        throw new WorkflowError(400, 'action phải là approve hoặc reject.');
      }
      const reviewComment = comment != null ? String(comment).slice(0, 8000) : null;
      let nextStep = stepForward(record.current_step, 5);
      let actionName = 'review_approved';
      if (act === 'reject') {
        nextStep = 3;
        actionName = 'review_rejected';
      }
      const updated = documentRepository.update(documentId, {
        reviewComment,
        reviewResult: act,
        reviewerId: actor && actor.id ? actor.id : null,
        reviewAt: new Date().toISOString(),
        currentStep: nextStep,
      });
      addHistory(documentId, 4, actionName, reviewComment || null, actor);
      publish(
        EVENT_TYPES.DocumentReviewed,
        {
          documentId,
          title: record.title || '',
          action: act,
          comment: reviewComment,
          assignedToId: record.assigned_to_id,
        },
        actor
      );
      return updated;
    },

    // ---- Step 5 - Add feedback ---------------------------------------------
    addFeedback({ documentId, content, actor }) {
      const record = requireRecord(documentRepository.findById(documentId));
      ensureActive(record);
      const clean = String(content || '').trim();
      if (!clean) throw new WorkflowError(400, 'Nội dung góp ý không được để trống.');
      const id = documentRepository.addFeedback(documentId, {
        authorId: actor && actor.id ? actor.id : null,
        content: clean.slice(0, 8000),
      });
      if (Number(record.current_step) < 6) {
        documentRepository.update(documentId, { currentStep: 6 });
      }
      addHistory(documentId, 5, 'feedback_added', clean.slice(0, 200), actor);
      publish(
        EVENT_TYPES.FeedbackAdded,
        {
          documentId,
          title: record.title || '',
          contentPreview: clean.slice(0, 180),
        },
        actor
      );
      return id;
    },

    // ---- Step 6 - Finalize draft -------------------------------------------
    finalizeDraft({ documentId, body, files, actor }) {
      const record = requireRecord(documentRepository.findById(documentId));
      ensureActive(record);
      const b = body || {};
      const updated = documentRepository.update(documentId, {
        explainReceive: b.explainReceive != null ? String(b.explainReceive).slice(0, 10000) : null,
        feedbackSummary: b.feedbackSummary != null ? String(b.feedbackSummary).slice(0, 8000) : null,
        meetingHeld: !!b.meetingHeld,
        meetingMinutesNote:
          b.meetingMinutesNote != null ? String(b.meetingMinutesNote).slice(0, 5000) : null,
        currentStep: stepForward(record.current_step, 7),
      });
      const attachmentIds = saveFiles(documentId, 6, files, 'final_draft', actor && actor.id);
      addHistory(documentId, 6, 'draft_finalized', `Hoàn thiện dự thảo (${attachmentIds.length} file)`, actor);
      publish(
        EVENT_TYPES.DraftFinalized,
        { documentId, title: updated.title || record.title || '' },
        actor
      );
      return { updated, attachmentIds };
    },

    // ---- Step 7 - Submit for sign ------------------------------------------
    submitDocument({ documentId, submitNote, files, actor }) {
      const record = requireRecord(documentRepository.findById(documentId));
      ensureActive(record);
      const note = submitNote != null ? String(submitNote).slice(0, 5000) : null;
      const updated = documentRepository.update(documentId, {
        submitNote: note,
        currentStep: stepForward(record.current_step, 8),
      });
      const attachmentIds = saveFiles(documentId, 7, files, 'submission_package', actor && actor.id);
      addHistory(documentId, 7, 'submitted_for_sign', note || 'Trình ký ban hành', actor);
      publish(
        EVENT_TYPES.DocumentSubmitted,
        { documentId, title: updated.title || record.title || '' },
        actor
      );
      return { updated, attachmentIds };
    },

    // ---- Step 8 - Publish ---------------------------------------------------
    publishDocument({ documentId, body, files, actor }) {
      const record = requireRecord(documentRepository.findById(documentId));
      ensureActive(record);
      const b = body || {};
      const updated = documentRepository.update(documentId, {
        signedConfirmed: !!b.signedConfirmed,
        publishDate: b.publishDate != null ? String(b.publishDate).slice(0, 10) : null,
        documentNumber: b.documentNumber != null ? String(b.documentNumber).slice(0, 120) : null,
        currentStep: stepForward(record.current_step, 9),
      });
      const attachmentIds = saveFiles(documentId, 8, files, 'published_copy', actor && actor.id);
      addHistory(documentId, 8, 'document_published', updated.document_number || null, actor);
      publish(
        EVENT_TYPES.DocumentPublished,
        {
          documentId,
          title: updated.title || '',
          documentNumber: updated.document_number || null,
          publishDate: updated.publish_date || null,
        },
        actor
      );
      return { updated, attachmentIds };
    },

    // ---- Step 9 - Archive ---------------------------------------------------
    archiveDocument({ documentId, body, actor }) {
      const record = requireRecord(documentRepository.findById(documentId));
      ensureActive(record);
      const b = body || {};
      const updated = documentRepository.update(documentId, {
        archivedAt: new Date().toISOString(),
        expireDate: b.expireDate != null ? String(b.expireDate).slice(0, 10) : null,
        remindAfterDays:
          b.remindAfterDays != null && Number.isFinite(Number(b.remindAfterDays))
            ? Number(b.remindAfterDays)
            : null,
        currentStep: 9,
        status: 'archived',
      });
      addHistory(documentId, 9, 'document_archived', 'Lưu trữ và hậu kiểm hồ sơ', actor);
      publish(
        EVENT_TYPES.DocumentArchived,
        { documentId, title: updated.title || record.title || '' },
        actor
      );
      return updated;
    },

    // ---- Generic upload attachments ----------------------------------------
    uploadAttachments({ documentId, step, category, files, actor }) {
      const record = requireRecord(documentRepository.findById(documentId));
      ensureActive(record);
      const stepNum = Math.min(9, Math.max(1, Number(step) || record.current_step || 1));
      const cat = category != null ? String(category).slice(0, 80) : null;
      const ids = saveFiles(documentId, stepNum, files, cat, actor && actor.id);
      addHistory(documentId, stepNum, 'attachment_added', `Upload bổ sung ${ids.length} file`, actor);
      return ids;
    },

    // ---- Attachment lookup (controller co auth check sau) ------------------
    findAttachmentWithContext(attachmentId) {
      return documentRepository.findAttachmentWithContext(attachmentId);
    },
  };
}

module.exports = {
  createDocumentWorkflowService,
  WorkflowError,
  ALLOWED_DOC_TYPES,
};
