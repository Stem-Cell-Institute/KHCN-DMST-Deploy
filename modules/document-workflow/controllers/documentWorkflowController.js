const path = require('path');
const fs = require('fs');

const ALLOWED_DOC_TYPES = ['quy_che', 'quy_dinh', 'noi_quy', 'huong_dan'];

function parseId(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function stepForward(currentStep, forcedNextStep) {
  if (forcedNextStep != null) return forcedNextStep;
  return Math.min(9, Math.max(1, Number(currentStep) + 1));
}

function createDocumentWorkflowController(deps) {
  const { db, documentModel, uploadsRoot, hasAnyRole, canAccessDocument, mailSend, baseUrl } = deps;

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

  function resolveRecipients(eventKey, fallbackRecipients) {
    // Luôn dùng danh sách người nhận tự động theo logic nghiệp vụ.
    // Không nhận override thủ công từ module_settings.email_recipients.
    return Array.from(new Set((fallbackRecipients || []).filter(Boolean)));
  }

  function documentLink(documentId) {
    const base = String(baseUrl || process.env.BASE_URL || '').replace(/\/$/, '');
    return base ? `${base}/tai-lieu-hanh-chinh.html?documentId=${documentId}` : `/tai-lieu-hanh-chinh.html?documentId=${documentId}`;
  }

  function composeFormalEmail(lines) {
    return (
      `Kính gửi Thầy/Cô,\n\n` +
      `${(lines || []).filter(Boolean).join('\n')}\n\n` +
      `Trân trọng,\n` +
      `Hệ thống quản lý quy trình ban hành văn bản nội bộ`
    );
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
      const rows = db
        .prepare(`SELECT email FROM users WHERE lower(trim(role)) = ? AND trim(COALESCE(email,'')) <> ''`)
        .all(String(role || '').toLowerCase());
      return Array.from(new Set((rows || []).map((r) => String(r.email || '').trim()).filter(Boolean)));
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

  function saveFiles(documentId, step, files, category, uploadedBy) {
    const ids = [];
    for (const f of files || []) {
      const relPath = `/uploads/documents/${documentId}/step_${step}/${f.filename}`;
      ids.push(
        documentModel.addAttachment(documentId, {
          step,
          category: category || null,
          originalName: f.originalname,
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
      const rows = db.prepare(`SELECT id, code, name FROM units WHERE active = 1 ORDER BY name`).all();
      return res.json({ ok: true, data: rows });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không tải được danh sách đơn vị.' });
    }
  }

  function getAssignableUsers(req, res) {
    try {
      const rows = db
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
      return res.json({ ok: true, data: documentModel.getDashboardStats() });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không tải được thống kê dashboard.' });
    }
  }

  function createDocument(req, res) {
    try {
      const body = req.body || {};
      const title = String(body.title || '').trim();
      const docType = String(body.docType || body.doc_type || '')
        .trim()
        .toLowerCase();
      if (!title) return res.status(400).json({ message: 'Thiếu tiêu đề.' });
      if (!ALLOWED_DOC_TYPES.includes(docType)) {
        return res.status(400).json({ message: 'Loại văn bản không hợp lệ.' });
      }
      const record = documentModel.create({
        title,
        docType,
        reason: body.reason != null ? String(body.reason).trim() : null,
        proposalSummary: body.proposalSummary != null ? String(body.proposalSummary).trim() : null,
        proposerId: req.user.id,
        proposerUnit:
          req.user && (req.user.unit || req.user.department_id || req.user.departmentId)
            ? String(req.user.unit || req.user.department_id || req.user.departmentId)
            : null,
      });
      history(record.id, 1, 'proposal_created', 'Khởi tạo đề xuất văn bản', req);
      safeSendMail({
        to: getModuleManagerEmails(),
        subject: `[DOCFLOW] Hồ sơ mới được tạo: #${record.id}`,
        text: composeFormalEmail([
          `Hồ sơ "${record.title || ''}" vừa được tạo ở bước 1.`,
          `Loại văn bản: ${record.doc_type || 'N/A'}`,
          `Xem chi tiết: ${documentLink(record.id)}`,
        ]),
      });
      return res.status(201).json({ ok: true, data: record });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không tạo được hồ sơ.' });
    }
  }

  function getDocuments(req, res) {
    try {
      const result = documentModel.findAll({
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
      return res.status(500).json({ message: e.message || 'Không tải được danh sách hồ sơ.' });
    }
  }

  function getDocumentDetail(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!canAccessDocument(req, record)) {
        return res.status(403).json({ message: 'Bạn không có quyền xem hồ sơ này.' });
      }
      return res.json({
        ok: true,
        data: {
          ...record,
          attachments: documentModel.getAttachments(documentId),
          feedback: documentModel.getFeedback(documentId),
          history: documentModel.getHistory(documentId),
        },
      });
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
        return res.status(403).json({ message: 'Chỉ Module Manager hoặc Master Admin được sửa hồ sơ trực tiếp.' });
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
        return res.status(403).json({ message: 'Chỉ Module Manager hoặc Master Admin được hủy quy trình.' });
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
      const record = documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!ensureWorkflowActive(record, res)) return;
      const unitId = parseId(req.body && req.body.unitId);
      let assignedToId = parseId(req.body && req.body.assignedToId);
      if (!assignedToId && req.body && req.body.assignedToName != null) {
        const raw = String(req.body.assignedToName).trim();
        if (raw) {
          const m = raw.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
          const email = m ? String(m[1] || '').trim().toLowerCase() : '';
          if (email) {
            const byEmail = db
              .prepare(`SELECT id FROM users WHERE lower(trim(email)) = ? ORDER BY id DESC LIMIT 1`)
              .get(email);
            assignedToId = byEmail && byEmail.id ? parseId(byEmail.id) : null;
          }
          if (!assignedToId) {
            const simpleName = raw.replace(/\([^()]*\)\s*$/, '').trim();
            const byName = db
              .prepare(`SELECT id FROM users WHERE trim(fullname) = ? ORDER BY id DESC LIMIT 1`)
              .get(simpleName || raw);
            assignedToId = byName && byName.id ? parseId(byName.id) : null;
          }
        }
      }
      if (!unitId || !assignedToId) {
        return res.status(400).json({ message: 'Thiếu unitId hoặc assignedToId.' });
      }
      const nextStep = stepForward(record.current_step, 3);
      const updated = documentModel.update(documentId, {
        assignedUnitId: unitId,
        assignedToId,
        assignmentDeadline:
          req.body && req.body.deadline != null ? String(req.body.deadline).slice(0, 10) : null,
        currentStep: nextStep,
      });
      history(documentId, 2, 'draft_assigned', `Phân công soạn thảo user #${assignedToId}`, req);
      const to = getUserEmailById(assignedToId);
      const toList = resolveRecipients('assign', to ? [to] : []);
      const ccList = getModuleManagerEmails().filter((x) => !toList.includes(x));
      safeSendMail({
        to: toList,
        cc: ccList,
        subject: `[DOCFLOW] Phân công soạn thảo hồ sơ #${documentId}`,
        text: composeFormalEmail([
          `Quý Thầy/Cô được phân công soạn thảo hồ sơ: ${updated.title || ''}`,
          `Hạn hoàn thành: ${updated.assignment_deadline || 'chưa đặt'}`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
      return res.json({ ok: true, data: updated });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không phân công được hồ sơ.' });
    }
  }

  function saveDraft(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!ensureWorkflowActive(record, res)) return;
      if (Number(record.assigned_to_id) !== Number(req.user.id) && !hasAnyRole(req, ['admin', 'leader', 'module_manager', 'master_admin'])) {
        return res.status(403).json({ message: 'Chỉ người được phân công soạn thảo mới được thao tác.' });
      }
      const body = req.body || {};
      const nextStep = stepForward(record.current_step, 4);
      const updated = documentModel.update(documentId, {
        legalBasis: body.legalBasis != null ? String(body.legalBasis).slice(0, 5000) : null,
        scope: body.scope != null ? String(body.scope).slice(0, 5000) : null,
        applicableSubjects:
          body.applicableSubjects != null ? String(body.applicableSubjects).slice(0, 5000) : null,
        mainContent: body.mainContent != null ? String(body.mainContent).slice(0, 8000) : null,
        executionClause:
          body.executionClause != null ? String(body.executionClause).slice(0, 5000) : null,
        currentStep: nextStep,
      });
      const attachmentIds = saveFiles(documentId, 3, req.files || [], 'draft_v1', req.user.id);
      history(documentId, 3, 'upload_draft', `Tải dự thảo lần 1 (${attachmentIds.length} file)`, req);
      safeSendMail({
        to: getModuleManagerEmails(),
        subject: `[DOCFLOW] Hồ sơ #${documentId} hoàn tất bước 3`,
        text: composeFormalEmail([
          `Hồ sơ "${updated.title || record.title || ''}" đã upload dự thảo và chuyển sang bước 4.`,
          `Số file dự thảo: ${attachmentIds.length}`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
      return res.json({ ok: true, data: updated, attachmentIds });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không lưu được dự thảo.' });
    }
  }

  function reviewDocument(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!ensureWorkflowActive(record, res)) return;
      const action = String((req.body && req.body.action) || '')
        .trim()
        .toLowerCase();
      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ message: 'action phải là approve hoặc reject.' });
      }
      const comment = req.body && req.body.comment != null ? String(req.body.comment).slice(0, 8000) : null;
      let nextStep = stepForward(record.current_step, 5);
      let actionName = 'review_approved';
      if (action === 'reject') {
        nextStep = 3;
        actionName = 'review_rejected';
      }
      const updated = documentModel.update(documentId, {
        reviewComment: comment,
        reviewResult: action,
        reviewerId: req.user.id,
        reviewAt: new Date().toISOString(),
        currentStep: nextStep,
      });
      history(documentId, 4, actionName, comment || null, req);
      if (action === 'reject') {
        const to = getUserEmailById(record.assigned_to_id);
        safeSendMail({
          to: resolveRecipients('review_reject', to ? [to] : []),
          subject: `[DOCFLOW] Hồ sơ #${documentId} bị từ chối thẩm định`,
          text: composeFormalEmail([
            `Hồ sơ "${record.title || ''}" đã bị từ chối ở bước thẩm định và quay về bước 3.`,
            `Lý do: ${comment || 'Không có'}`,
            `Xem chi tiết: ${documentLink(documentId)}`,
          ]),
        });
      } else {
        const recipients = Array.from(
          new Set([
            ...getRoleEmails('drafter'),
            ...getRoleEmails('leader'),
            ...getRoleEmails('reviewer'),
            getUserEmailById(record.assigned_to_id),
          ].filter(Boolean))
        );
        safeSendMail({
          to: resolveRecipients('step5_approved', recipients),
          subject: `[DOCFLOW] Hồ sơ #${documentId} đã chuyển sang bước 5`,
          text: composeFormalEmail([
            `Hồ sơ "${record.title || ''}" đã được duyệt thẩm định và chuyển sang bước 5 (lấy ý kiến góp ý).`,
            `Kính đề nghị Quý Thầy/Cô phối hợp phản hồi góp ý theo quy trình.`,
            `Xem chi tiết: ${documentLink(documentId)}`,
          ]),
        });
      }
      return res.json({ ok: true, data: updated });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không xử lý được thẩm định.' });
    }
  }

  function addFeedback(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!ensureWorkflowActive(record, res)) return;
      const content = String((req.body && req.body.content) || '').trim();
      if (!content) return res.status(400).json({ message: 'Nội dung góp ý không được để trống.' });
      const id = documentModel.addFeedback(documentId, {
        authorId: req.user.id,
        content: content.slice(0, 8000),
      });
      if (Number(record.current_step) < 6) {
        documentModel.update(documentId, { currentStep: 6 });
      }
      history(documentId, 5, 'feedback_added', content.slice(0, 200), req);
      safeSendMail({
        to: getModuleManagerEmails(),
        subject: `[DOCFLOW] Hồ sơ #${documentId} có góp ý mới (bước 5)`,
        text: composeFormalEmail([
          `Hồ sơ "${record.title || ''}" đã có góp ý và chuyển sang bước 6.`,
          `Nội dung góp ý (rút gọn): ${content.slice(0, 180)}`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
      return res.status(201).json({ ok: true, data: { id } });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không thêm được góp ý.' });
    }
  }

  function finalizeDraft(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!ensureWorkflowActive(record, res)) return;
      if (Number(record.assigned_to_id) !== Number(req.user.id) && !hasAnyRole(req, ['admin', 'leader', 'module_manager', 'master_admin'])) {
        return res.status(403).json({ message: 'Chỉ người được phân công soạn thảo mới được thao tác.' });
      }
      const body = req.body || {};
      const updated = documentModel.update(documentId, {
        explainReceive: body.explainReceive != null ? String(body.explainReceive).slice(0, 10000) : null,
        feedbackSummary: body.feedbackSummary != null ? String(body.feedbackSummary).slice(0, 8000) : null,
        meetingHeld: !!body.meetingHeld,
        meetingMinutesNote:
          body.meetingMinutesNote != null ? String(body.meetingMinutesNote).slice(0, 5000) : null,
        currentStep: stepForward(record.current_step, 7),
      });
      const attachmentIds = saveFiles(documentId, 6, req.files || [], 'final_draft', req.user.id);
      history(documentId, 6, 'draft_finalized', `Hoàn thiện dự thảo (${attachmentIds.length} file)`, req);
      safeSendMail({
        to: getModuleManagerEmails(),
        subject: `[DOCFLOW] Hồ sơ #${documentId} hoàn tất bước 6`,
        text: composeFormalEmail([
          `Hồ sơ "${updated.title || record.title || ''}" đã hoàn thiện dự thảo và chuyển sang bước 7.`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
      return res.json({ ok: true, data: updated, attachmentIds });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không hoàn thiện được dự thảo.' });
    }
  }

  function submitDocument(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!ensureWorkflowActive(record, res)) return;
      if (Number(record.assigned_to_id) !== Number(req.user.id) && !hasAnyRole(req, ['admin', 'leader', 'module_manager', 'master_admin'])) {
        return res.status(403).json({ message: 'Chỉ người được phân công soạn thảo mới được thao tác.' });
      }
      const note = req.body && req.body.submitNote != null ? String(req.body.submitNote).slice(0, 5000) : null;
      const updated = documentModel.update(documentId, {
        submitNote: note,
        currentStep: stepForward(record.current_step, 8),
      });
      const attachmentIds = saveFiles(documentId, 7, req.files || [], 'submission_package', req.user.id);
      history(documentId, 7, 'submitted_for_sign', note || 'Trình ký ban hành', req);
      safeSendMail({
        to: getModuleManagerEmails(),
        subject: `[DOCFLOW] Hồ sơ #${documentId} hoàn tất bước 7`,
        text: composeFormalEmail([
          `Hồ sơ "${updated.title || record.title || ''}" đã trình ký và chuyển sang bước 8.`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
      return res.json({ ok: true, data: updated, attachmentIds });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không trình ký được hồ sơ.' });
    }
  }

  function publishDocument(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!ensureWorkflowActive(record, res)) return;
      const body = req.body || {};
      const updated = documentModel.update(documentId, {
        signedConfirmed: !!body.signedConfirmed,
        publishDate: body.publishDate != null ? String(body.publishDate).slice(0, 10) : null,
        documentNumber: body.documentNumber != null ? String(body.documentNumber).slice(0, 120) : null,
        currentStep: stepForward(record.current_step, 9),
      });
      const attachmentIds = saveFiles(documentId, 8, req.files || [], 'published_copy', req.user.id);
      history(documentId, 8, 'document_published', updated.document_number || null, req);
      safeSendMail({
        to: resolveRecipients('publish', getAllUnitEmails()),
        subject: `[DOCFLOW] Văn bản mới được ban hành: ${updated.document_number || `#${documentId}`}`,
        text: composeFormalEmail([
          `Văn bản "${updated.title || ''}" đã được ban hành.`,
          `Số hiệu: ${updated.document_number || 'N/A'}`,
          `Ngày ban hành: ${updated.publish_date || 'N/A'}`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
      return res.json({ ok: true, data: updated, attachmentIds });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không ban hành được văn bản.' });
    }
  }

  function archiveDocument(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentModel.findById(documentId);
      if (!record) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!ensureWorkflowActive(record, res)) return;
      const body = req.body || {};
      const updated = documentModel.update(documentId, {
        archivedAt: new Date().toISOString(),
        expireDate: body.expireDate != null ? String(body.expireDate).slice(0, 10) : null,
        remindAfterDays:
          body.remindAfterDays != null && Number.isFinite(Number(body.remindAfterDays))
            ? Number(body.remindAfterDays)
            : null,
        currentStep: 9,
        status: 'archived',
      });
      history(documentId, 9, 'document_archived', 'Lưu trữ và hậu kiểm hồ sơ', req);
      safeSendMail({
        to: getModuleManagerEmails(),
        subject: `[DOCFLOW] Hồ sơ #${documentId} hoàn tất bước 9`,
        text: composeFormalEmail([
          `Hồ sơ "${updated.title || record.title || ''}" đã lưu trữ/hậu kiểm.`,
          `Xem chi tiết: ${documentLink(documentId)}`,
        ]),
      });
      return res.json({ ok: true, data: updated });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không lưu trữ được hồ sơ.' });
    }
  }

  function uploadAttachments(req, res) {
    try {
      const documentId = parseId(req.params.id);
      if (!documentId) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      const record = documentModel.findById(documentId);
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
      const attachment = db
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
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(attachment.original_name || path.basename(normalized))}"`
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
