const { Document } = require('../../domain/document/Document');
const { stepForward } = require('../../domain/document/WorkflowStep');
const { WorkflowEvents } = require('../../domain/events/WorkflowEvents');

class DocumentWorkflowService {
  constructor(deps) {
    const {
      documentRepository,
      unitRepository,
      userRepository,
      settingsRepository,
      eventBus,
      hasAnyRole,
      canAccessDocument,
    } = deps;
    this.documentRepository = documentRepository;
    this.unitRepository = unitRepository;
    this.userRepository = userRepository;
    this.settingsRepository = settingsRepository;
    this.eventBus = eventBus;
    this.hasAnyRole = hasAnyRole;
    this.canAccessDocument = canAccessDocument;
  }

  actorName(req) {
    return req.user && (req.user.fullName || req.user.fullname || req.user.email)
      ? String(req.user.fullName || req.user.fullname || req.user.email)
      : null;
  }

  addHistory(documentId, step, action, note, req) {
    return this.documentRepository.addHistory(documentId, {
      step,
      action,
      note: note || null,
      actorId: req.user && req.user.id ? req.user.id : null,
      actorName: this.actorName(req),
    });
  }

  ensureWorkflowActive(record) {
    const status = String((record && record.status) || '').trim().toLowerCase();
    if (status === 'aborted') {
      return {
        ok: false,
        status: 400,
        message: 'Hồ sơ đã dừng quy trình (aborted), không thể thao tác thêm.',
      };
    }
    return { ok: true };
  }

  saveFiles(documentId, step, files, category, uploadedBy) {
    const ids = [];
    for (const f of files || []) {
      const relPath = `/uploads/documents/${documentId}/step_${step}/${f.filename}`;
      ids.push(
        this.documentRepository.addAttachment(documentId, {
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

  createDocument(input) {
    const { body, user, req } = input;
    const check = Document.ensureValidCreatePayload(body);
    if (!check.ok) {
      return { ok: false, status: 400, message: check.message };
    }
    const record = this.documentRepository.create({
      title: check.value.title,
      docType: check.value.docType,
      reason: body.reason != null ? String(body.reason).trim() : null,
      proposalSummary:
        body.proposalSummary != null ? String(body.proposalSummary).trim() : null,
      proposerId: user.id,
      proposerUnit:
        user && (user.unit || user.department_id || user.departmentId)
          ? String(user.unit || user.department_id || user.departmentId)
          : null,
    });
    this.addHistory(record.id, 1, 'proposal_created', 'Khởi tạo đề xuất văn bản', req);
    this.eventBus.publish(WorkflowEvents.PROPOSAL_CREATED, { record });
    return { ok: true, data: record };
  }

  getDocuments(input) {
    const { query, req } = input;
    const result = this.documentRepository.findAll({
      step: query.step,
      unitId: query.unitId,
      status: query.status,
      search: query.search,
      page: query.page,
      limit: query.limit,
    });
    const filtered = result.rows.filter((doc) => this.canAccessDocument(req, doc));
    return {
      ok: true,
      data: filtered,
      pagination: { ...result.pagination, visible: filtered.length },
    };
  }

  getDocumentDetail(input) {
    const { documentId, req } = input;
    const record = this.documentRepository.findById(documentId);
    if (!record) return { ok: false, status: 404, message: 'Không tìm thấy hồ sơ.' };
    if (!this.canAccessDocument(req, record)) {
      return { ok: false, status: 403, message: 'Bạn không có quyền xem hồ sơ này.' };
    }
    return {
      ok: true,
      data: {
        ...record,
        attachments: this.documentRepository.getAttachments(documentId),
        feedback: this.documentRepository.getFeedback(documentId),
        history: this.documentRepository.getHistory(documentId),
      },
    };
  }

  assignDocument(input) {
    const { documentId, body, req } = input;
    const record = this.documentRepository.findById(documentId);
    if (!record) return { ok: false, status: 404, message: 'Không tìm thấy hồ sơ.' };
    const active = this.ensureWorkflowActive(record);
    if (!active.ok) return active;

    const unitId = Number(body && body.unitId);
    const assignedToId = this.userRepository.resolveAssigneeId(body || {});
    if (!Number.isFinite(unitId) || unitId <= 0 || !assignedToId) {
      return { ok: false, status: 400, message: 'Thiếu unitId hoặc assignedToId.' };
    }
    const updated = this.documentRepository.update(documentId, {
      assignedUnitId: unitId,
      assignedToId,
      assignmentDeadline:
        body && body.deadline != null ? String(body.deadline).slice(0, 10) : null,
      currentStep: stepForward(record.current_step, 3),
    });
    this.addHistory(
      documentId,
      2,
      'draft_assigned',
      `Phân công soạn thảo user #${assignedToId}`,
      req
    );
    this.eventBus.publish(WorkflowEvents.ASSIGNMENT_COMPLETED, {
      documentId,
      updated,
      assignedToId,
    });
    return { ok: true, data: updated };
  }

  saveDraft(input) {
    const { documentId, body, req, files } = input;
    const record = this.documentRepository.findById(documentId);
    if (!record) return { ok: false, status: 404, message: 'Không tìm thấy hồ sơ.' };
    const active = this.ensureWorkflowActive(record);
    if (!active.ok) return active;
    if (
      Number(record.assigned_to_id) !== Number(req.user.id) &&
      !this.hasAnyRole(req, ['admin', 'leader', 'module_manager', 'master_admin'])
    ) {
      return {
        ok: false,
        status: 403,
        message: 'Chỉ người được phân công soạn thảo mới được thao tác.',
      };
    }
    const updated = this.documentRepository.update(documentId, {
      legalBasis: body.legalBasis != null ? String(body.legalBasis).slice(0, 5000) : null,
      scope: body.scope != null ? String(body.scope).slice(0, 5000) : null,
      applicableSubjects:
        body.applicableSubjects != null
          ? String(body.applicableSubjects).slice(0, 5000)
          : null,
      mainContent:
        body.mainContent != null ? String(body.mainContent).slice(0, 8000) : null,
      executionClause:
        body.executionClause != null
          ? String(body.executionClause).slice(0, 5000)
          : null,
      currentStep: stepForward(record.current_step, 4),
    });
    const attachmentIds = this.saveFiles(
      documentId,
      3,
      files || [],
      'draft_v1',
      req.user.id
    );
    this.addHistory(
      documentId,
      3,
      'upload_draft',
      `Tải dự thảo lần 1 (${attachmentIds.length} file)`,
      req
    );
    this.eventBus.publish(WorkflowEvents.DRAFT_STEP3_COMPLETED, {
      documentId,
      updated,
      recordTitle: record.title,
      attachmentCount: attachmentIds.length,
    });
    return { ok: true, data: updated, attachmentIds };
  }

  reviewDocument(input) {
    const { documentId, body, req } = input;
    const record = this.documentRepository.findById(documentId);
    if (!record) return { ok: false, status: 404, message: 'Không tìm thấy hồ sơ.' };
    const active = this.ensureWorkflowActive(record);
    if (!active.ok) return active;
    const action = String((body && body.action) || '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(action)) {
      return {
        ok: false,
        status: 400,
        message: 'action phải là approve hoặc reject.',
      };
    }
    const comment =
      body && body.comment != null ? String(body.comment).slice(0, 8000) : null;
    let nextStep = stepForward(record.current_step, 5);
    let actionName = 'review_approved';
    if (action === 'reject') {
      nextStep = 3;
      actionName = 'review_rejected';
    }
    const updated = this.documentRepository.update(documentId, {
      reviewComment: comment,
      reviewResult: action,
      reviewerId: req.user.id,
      reviewAt: new Date().toISOString(),
      currentStep: nextStep,
    });
    this.addHistory(documentId, 4, actionName, comment || null, req);
    if (action === 'reject') {
      this.eventBus.publish(WorkflowEvents.REVIEW_REJECTED, {
        documentId,
        record,
        comment,
      });
    } else {
      this.eventBus.publish(WorkflowEvents.REVIEW_APPROVED_STEP5, {
        documentId,
        record,
      });
    }
    return { ok: true, data: updated };
  }

  addFeedback(input) {
    const { documentId, body, req } = input;
    const record = this.documentRepository.findById(documentId);
    if (!record) return { ok: false, status: 404, message: 'Không tìm thấy hồ sơ.' };
    const active = this.ensureWorkflowActive(record);
    if (!active.ok) return active;
    const content = String((body && body.content) || '').trim();
    if (!content) {
      return {
        ok: false,
        status: 400,
        message: 'Nội dung góp ý không được để trống.',
      };
    }
    const id = this.documentRepository.addFeedback(documentId, {
      authorId: req.user.id,
      content: content.slice(0, 8000),
    });
    if (Number(record.current_step) < 6) {
      this.documentRepository.update(documentId, { currentStep: 6 });
    }
    this.addHistory(documentId, 5, 'feedback_added', content.slice(0, 200), req);
    this.eventBus.publish(WorkflowEvents.FEEDBACK_ADDED, {
      documentId,
      record,
      content,
    });
    return { ok: true, status: 201, data: { id } };
  }

  finalizeDraft(input) {
    const { documentId, body, req, files } = input;
    const record = this.documentRepository.findById(documentId);
    if (!record) return { ok: false, status: 404, message: 'Không tìm thấy hồ sơ.' };
    const active = this.ensureWorkflowActive(record);
    if (!active.ok) return active;
    if (
      Number(record.assigned_to_id) !== Number(req.user.id) &&
      !this.hasAnyRole(req, ['admin', 'leader', 'module_manager', 'master_admin'])
    ) {
      return {
        ok: false,
        status: 403,
        message: 'Chỉ người được phân công soạn thảo mới được thao tác.',
      };
    }
    const updated = this.documentRepository.update(documentId, {
      explainReceive:
        body.explainReceive != null
          ? String(body.explainReceive).slice(0, 10000)
          : null,
      feedbackSummary:
        body.feedbackSummary != null
          ? String(body.feedbackSummary).slice(0, 8000)
          : null,
      meetingHeld: !!body.meetingHeld,
      meetingMinutesNote:
        body.meetingMinutesNote != null
          ? String(body.meetingMinutesNote).slice(0, 5000)
          : null,
      currentStep: stepForward(record.current_step, 7),
    });
    const attachmentIds = this.saveFiles(
      documentId,
      6,
      files || [],
      'final_draft',
      req.user.id
    );
    this.addHistory(
      documentId,
      6,
      'draft_finalized',
      `Hoàn thiện dự thảo (${attachmentIds.length} file)`,
      req
    );
    this.eventBus.publish(WorkflowEvents.FINALIZE_STEP6_COMPLETED, {
      documentId,
      updated,
      recordTitle: record.title,
    });
    return { ok: true, data: updated, attachmentIds };
  }

  submitDocument(input) {
    const { documentId, body, req, files } = input;
    const record = this.documentRepository.findById(documentId);
    if (!record) return { ok: false, status: 404, message: 'Không tìm thấy hồ sơ.' };
    const active = this.ensureWorkflowActive(record);
    if (!active.ok) return active;
    if (
      Number(record.assigned_to_id) !== Number(req.user.id) &&
      !this.hasAnyRole(req, ['admin', 'leader', 'module_manager', 'master_admin'])
    ) {
      return {
        ok: false,
        status: 403,
        message: 'Chỉ người được phân công soạn thảo mới được thao tác.',
      };
    }
    const note =
      body && body.submitNote != null ? String(body.submitNote).slice(0, 5000) : null;
    const updated = this.documentRepository.update(documentId, {
      submitNote: note,
      currentStep: stepForward(record.current_step, 8),
    });
    const attachmentIds = this.saveFiles(
      documentId,
      7,
      files || [],
      'submission_package',
      req.user.id
    );
    this.addHistory(
      documentId,
      7,
      'submitted_for_sign',
      note || 'Trình ký ban hành',
      req
    );
    this.eventBus.publish(WorkflowEvents.SUBMIT_STEP7_COMPLETED, {
      documentId,
      updated,
      recordTitle: record.title,
    });
    return { ok: true, data: updated, attachmentIds };
  }

  publishDocument(input) {
    const { documentId, body, req, files } = input;
    const record = this.documentRepository.findById(documentId);
    if (!record) return { ok: false, status: 404, message: 'Không tìm thấy hồ sơ.' };
    const active = this.ensureWorkflowActive(record);
    if (!active.ok) return active;
    const updated = this.documentRepository.update(documentId, {
      signedConfirmed: !!body.signedConfirmed,
      publishDate:
        body.publishDate != null ? String(body.publishDate).slice(0, 10) : null,
      documentNumber:
        body.documentNumber != null ? String(body.documentNumber).slice(0, 120) : null,
      currentStep: stepForward(record.current_step, 9),
    });
    const attachmentIds = this.saveFiles(
      documentId,
      8,
      files || [],
      'published_copy',
      req.user.id
    );
    this.addHistory(
      documentId,
      8,
      'document_published',
      updated.document_number || null,
      req
    );
    this.eventBus.publish(WorkflowEvents.PUBLISHED, { documentId, updated });
    return { ok: true, data: updated, attachmentIds };
  }

  archiveDocument(input) {
    const { documentId, body, req } = input;
    const record = this.documentRepository.findById(documentId);
    if (!record) return { ok: false, status: 404, message: 'Không tìm thấy hồ sơ.' };
    const active = this.ensureWorkflowActive(record);
    if (!active.ok) return active;
    const updated = this.documentRepository.update(documentId, {
      archivedAt: new Date().toISOString(),
      expireDate:
        body.expireDate != null ? String(body.expireDate).slice(0, 10) : null,
      remindAfterDays:
        body.remindAfterDays != null && Number.isFinite(Number(body.remindAfterDays))
          ? Number(body.remindAfterDays)
          : null,
      currentStep: 9,
      status: 'archived',
    });
    this.addHistory(documentId, 9, 'document_archived', 'Lưu trữ và hậu kiểm hồ sơ', req);
    this.eventBus.publish(WorkflowEvents.ARCHIVED, {
      documentId,
      updated,
      recordTitle: record.title,
    });
    return { ok: true, data: updated };
  }
}

module.exports = {
  DocumentWorkflowService,
};
