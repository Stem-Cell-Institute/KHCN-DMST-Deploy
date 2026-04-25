class DocumentModel {
  constructor(db) {
    this.db = db;
  }

  static parseRoleTokens(value) {
    return String(value || '')
      .split(/[,\s;|]+/)
      .map((x) => String(x || '').trim().toLowerCase())
      .filter(Boolean);
  }

  static uniqTokens(list) {
    return Array.from(new Set((list || []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)));
  }

  static systemRoleSet() {
    return new Set([
      'user',
      'researcher',
      'admin',
      'manager',
      'phong_khcn',
      'vien_truong',
      'thu_ky',
      'chu_tich',
      'thanh_vien',
      'totruong_tham_dinh_tc',
      'thanh_vien_tham_dinh_tc',
      'crd_user',
      'ke_toan',
      'pho_vien_truong',
    ]);
  }

  static pickSystemRole(tokens, fallbackRole) {
    const roleSet = DocumentModel.systemRoleSet();
    const normalizedFallback = String(fallbackRole || '').trim().toLowerCase();
    const tokenList = DocumentModel.uniqTokens(tokens);
    const inToken = tokenList.filter((r) => roleSet.has(r));
    if (normalizedFallback && roleSet.has(normalizedFallback) && inToken.includes(normalizedFallback)) {
      return normalizedFallback;
    }
    if (inToken.includes('admin')) return 'admin';
    if (inToken.includes('researcher')) return 'researcher';
    if (inToken.length) return inToken[0];
    if (normalizedFallback && roleSet.has(normalizedFallback)) return normalizedFallback;
    return 'researcher';
  }

  static extractWorkflowRoles(tokens) {
    const roleSet = DocumentModel.systemRoleSet();
    const workflowAllowed = new Set([
      'master_admin',
      'module_manager',
      'proposer',
      'leader',
      'reviewer',
      'drafter',
    ]);
    return DocumentModel.uniqTokens(tokens).filter((r) => !roleSet.has(r) && workflowAllowed.has(r));
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS units (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        doc_type TEXT NOT NULL,
        reason TEXT,
        proposal_summary TEXT,
        proposer_id INTEGER REFERENCES users(id),
        proposer_unit TEXT,
        current_step INTEGER NOT NULL DEFAULT 1 CHECK(current_step BETWEEN 1 AND 9),
        status TEXT NOT NULL DEFAULT 'in_progress',
        assigned_unit_id INTEGER,
        assigned_to_id INTEGER REFERENCES users(id),
        assignment_deadline TEXT,
        legal_basis TEXT,
        scope TEXT,
        applicable_subjects TEXT,
        main_content TEXT,
        execution_clause TEXT,
        review_comment TEXT,
        review_result TEXT,
        reviewer_id INTEGER REFERENCES users(id),
        review_at TEXT,
        feedback_summary TEXT,
        meeting_held INTEGER NOT NULL DEFAULT 0,
        meeting_minutes_note TEXT,
        explain_receive TEXT,
        submit_note TEXT,
        signed_confirmed INTEGER NOT NULL DEFAULT 0,
        publish_date TEXT,
        document_number TEXT,
        archived_at TEXT,
        expire_date TEXT,
        remind_after_days INTEGER,
        deleted_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS document_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        step INTEGER NOT NULL,
        category TEXT,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT,
        file_size INTEGER,
        file_path TEXT NOT NULL,
        uploaded_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS document_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        author_id INTEGER REFERENCES users(id),
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS document_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        step INTEGER NOT NULL,
        action TEXT NOT NULL,
        note TEXT,
        actor_id INTEGER REFERENCES users(id),
        actor_name TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS module_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT,
        updated_by INTEGER REFERENCES users(id),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS document_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_by INTEGER REFERENCES users(id),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        action TEXT NOT NULL,
        target_type TEXT,
        target_id INTEGER,
        old_value TEXT,
        new_value TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        UNIQUE(user_id, role)
      );

    `);

    const existingCols = new Set(
      (this.db.prepare(`PRAGMA table_info(documents)`).all() || []).map((c) => String(c.name || ''))
    );
    const userCols = new Set((this.db.prepare(`PRAGMA table_info(users)`).all() || []).map((c) => String(c.name || '')));

    function addColumnIfMissing(db, colSet, columnName, alterSql) {
      if (colSet.has(columnName)) return;
      try {
        db.prepare(alterSql).run();
        colSet.add(columnName);
      } catch (_) {}
    }

    // Tuong thich DB cu: schema da co assigned_drafter_id nhung chua co assigned_to_id.
    addColumnIfMissing(
      this.db,
      existingCols,
      'assigned_to_id',
      `ALTER TABLE documents ADD COLUMN assigned_to_id INTEGER REFERENCES users(id)`
    );
    addColumnIfMissing(
      this.db,
      existingCols,
      'assigned_unit_id',
      `ALTER TABLE documents ADD COLUMN assigned_unit_id INTEGER`
    );
    addColumnIfMissing(
      this.db,
      existingCols,
      'assignment_deadline',
      `ALTER TABLE documents ADD COLUMN assignment_deadline TEXT`
    );
    addColumnIfMissing(this.db, existingCols, 'deleted_at', `ALTER TABLE documents ADD COLUMN deleted_at TEXT`);
    addColumnIfMissing(this.db, userCols, 'is_active', `ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);

    if (!existingCols.has('assigned_to_id') && existingCols.has('assigned_drafter_id')) {
      // no-op fallback, ly thuyet khong vao day vi addColumnIfMissing da cap nhat colSet
    }
    if (existingCols.has('assigned_to_id') && existingCols.has('assigned_drafter_id')) {
      try {
        this.db.prepare(
          `UPDATE documents
           SET assigned_to_id = COALESCE(assigned_to_id, assigned_drafter_id)
           WHERE assigned_to_id IS NULL AND assigned_drafter_id IS NOT NULL`
        ).run();
      } catch (_) {}
    }
    if (userCols.has('is_active') && userCols.has('is_banned')) {
      try {
        this.db.prepare(`UPDATE users SET is_active = CASE WHEN COALESCE(is_banned,0)=1 THEN 0 ELSE COALESCE(is_active,1) END`).run();
      } catch (_) {}
    }

    // Tao index rieng le de tranh fail ca khoi khi thieu cot trong DB cu.
    const safeIndexes = [
      `CREATE INDEX IF NOT EXISTS idx_documents_step ON documents(current_step)`,
      `CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)`,
      `CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title)`,
      `CREATE INDEX IF NOT EXISTS idx_documents_assigned_unit ON documents(assigned_unit_id)`,
      `CREATE INDEX IF NOT EXISTS idx_documents_assigned_to ON documents(assigned_to_id)`,
      `CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_document_attachments_document ON document_attachments(document_id)`,
      `CREATE INDEX IF NOT EXISTS idx_document_feedback_document ON document_feedback(document_id)`,
      `CREATE INDEX IF NOT EXISTS idx_document_history_document ON document_history(document_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_document_types_active ON document_types(is_active)`,
    ];
    for (const sql of safeIndexes) {
      try {
        this.db.prepare(sql).run();
      } catch (_) {}
    }
    try {
      this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id)`).run();
    } catch (_) {}

    this.db
      .prepare(`INSERT OR IGNORE INTO module_settings(setting_key, setting_value) VALUES ('default_assignment_days', '14')`)
      .run();
    this.db
      .prepare(`INSERT OR IGNORE INTO module_settings(setting_key, setting_value) VALUES ('default_review_remind_days', '180')`)
      .run();
    this.db
      .prepare(`INSERT OR IGNORE INTO module_settings(setting_key, setting_value) VALUES ('email_enabled', '1')`)
      .run();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO module_settings(setting_key, setting_value)
         VALUES ('email_templates', '{"assign":"Bạn được phân công soạn thảo.","review_reject":"Hồ sơ bị từ chối.","publish":"Văn bản đã ban hành."}')`
      )
      .run();
    this.db
      .prepare(`INSERT OR IGNORE INTO module_settings(setting_key, setting_value) VALUES ('email_recipients', '{}')`)
      .run();
    this.db
      .prepare(`INSERT OR IGNORE INTO module_settings(setting_key, setting_value) VALUES ('internal_domain_access_enabled', '0')`)
      .run();
    this.db
      .prepare(`INSERT OR IGNORE INTO module_settings(setting_key, setting_value) VALUES ('internal_domain_email_suffix', '@sci.edu.vn')`)
      .run();
    this.db
      .prepare(`INSERT OR IGNORE INTO module_settings(setting_key, setting_value) VALUES ('email_notification_toggles', '{}')`)
      .run();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO module_settings(setting_key, setting_value)
         VALUES ('step5_recipient_mode', 'module_manager_assigned')`
      )
      .run();
    this.migrateLegacyRoleCsvToUserRoles();

    const defaultTypes = [
      ['quy_che', 'Quy chế', 1],
      ['quy_dinh', 'Quy định', 2],
      ['noi_quy', 'Nội quy', 3],
      ['huong_dan', 'Hướng dẫn', 4],
    ];
    const upsertType = this.db.prepare(
      `INSERT OR IGNORE INTO document_types(code, name, is_active, sort_order) VALUES (?, ?, 1, ?)`
    );
    defaultTypes.forEach((x) => upsertType.run(x[0], x[1], x[2]));
  }

  create(payload) {
    const result = this.db
      .prepare(
        `INSERT INTO documents (
          title, doc_type, reason, proposal_summary, proposer_id, proposer_unit,
          current_step, status, assigned_unit_id, assigned_to_id, assignment_deadline
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.title,
        payload.docType,
        payload.reason || null,
        payload.proposalSummary || null,
        payload.proposerId || null,
        payload.proposerUnit || null,
        payload.currentStep || 1,
        payload.status || 'in_progress',
        payload.assignedUnitId || null,
        payload.assignedToId || null,
        payload.assignmentDeadline || null
      );
    return this.findById(result.lastInsertRowid);
  }

  migrateLegacyRoleCsvToUserRoles() {
    let users = [];
    try {
      users = this.db.prepare(`SELECT id, role FROM users`).all();
    } catch (_) {
      users = [];
    }
    if (!users.length) return;
    const upsertRole = this.db.prepare(`INSERT OR IGNORE INTO user_roles(user_id, role) VALUES (?, ?)`);
    const updateSystemRole = this.db.prepare(`UPDATE users SET role = ? WHERE id = ?`);
    const report = {
      totalUsersScanned: Number(users.length || 0),
      usersTouched: 0,
      workflowRoleRowsInserted: 0,
      normalizedSystemRoleRows: 0,
    };
    const tx = this.db.transaction((rows) => {
      for (const row of rows) {
        const tokens = DocumentModel.parseRoleTokens(row && row.role);
        if (!tokens.length) continue;
        const workflowRoles = DocumentModel.extractWorkflowRoles(tokens);
        const systemRole = DocumentModel.pickSystemRole(tokens, row && row.role);
        let touched = false;
        if (workflowRoles.length || String(row.role || '').includes(',') || /\s/.test(String(row.role || ''))) {
          updateSystemRole.run(systemRole, row.id);
          report.normalizedSystemRoleRows += 1;
          touched = true;
        }
        for (const wr of workflowRoles) {
          const r = upsertRole.run(row.id, wr);
          if (Number(r && r.changes) > 0) report.workflowRoleRowsInserted += 1;
          touched = true;
        }
        if (touched) report.usersTouched += 1;
      }
    });
    try {
      tx(users);
    } catch (_) {}
    if (report.usersTouched > 0) {
      const stamped = {
        ...report,
        migratedAt: new Date().toISOString(),
      };
      try {
        this.db
          .prepare(
            `INSERT INTO module_settings(setting_key, setting_value, updated_at)
             VALUES ('workflow_role_migration_report_v1', ?, datetime('now'))
             ON CONFLICT(setting_key) DO UPDATE SET
               setting_value=excluded.setting_value,
               updated_at=datetime('now')`
          )
          .run(JSON.stringify(stamped));
      } catch (_) {}
      try {
        console.log('[DOCFLOW role-migration v1]', JSON.stringify(stamped));
      } catch (_) {}
    }
  }

  getMergedRoleCsv(userId, baseRole) {
    const base = DocumentModel.parseRoleTokens(baseRole);
    let extra = [];
    try {
      const rows = this.db.prepare(`SELECT role FROM user_roles WHERE user_id = ?`).all(userId);
      extra = (rows || []).map((r) => String(r && r.role ? r.role : '').trim().toLowerCase()).filter(Boolean);
    } catch (_) {
      extra = [];
    }
    return DocumentModel.uniqTokens(base.concat(extra)).join(',');
  }

  syncUserWorkflowRoles(userId, rolesCsv) {
    const allTokens = DocumentModel.parseRoleTokens(rolesCsv);
    const workflowRoles = DocumentModel.extractWorkflowRoles(allTokens);
    const del = this.db.prepare(`DELETE FROM user_roles WHERE user_id = ?`);
    const ins = this.db.prepare(`INSERT OR IGNORE INTO user_roles(user_id, role) VALUES (?, ?)`);
    const tx = this.db.transaction((uid, list) => {
      del.run(uid);
      for (const role of list) {
        ins.run(uid, role);
      }
    });
    try {
      tx(userId, workflowRoles);
    } catch (_) {}
  }

  findById(id) {
    return this.db.prepare(`SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL`).get(id) || null;
  }

  getAttachments(documentId) {
    return this.db
      .prepare(
        `SELECT id, document_id, step, category, original_name, stored_name, mime_type, file_size, file_path, uploaded_by, created_at
         FROM document_attachments
         WHERE document_id = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(documentId);
  }

  getFeedback(documentId) {
    return this.db
      .prepare(
        `SELECT id, document_id, author_id, content, created_at
         FROM document_feedback
         WHERE document_id = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(documentId);
  }

  findAll({ step, unitId, status, search, page = 1, limit = 20 } = {}) {
    const where = ['1=1'];
    where.push('deleted_at IS NULL');
    const params = [];

    if (step != null && step !== '') {
      where.push('current_step = ?');
      params.push(Number(step));
    }
    if (unitId != null && unitId !== '') {
      where.push('assigned_unit_id = ?');
      params.push(Number(unitId));
    }
    if (status) {
      where.push('status = ?');
      params.push(String(status));
    }
    if (search) {
      where.push('lower(title) LIKE ?');
      params.push(`%${String(search).toLowerCase().replace(/[%_]/g, '')}%`);
    }

    const whereSql = where.join(' AND ');
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const offset = (safePage - 1) * safeLimit;
    const total = this.db.prepare(`SELECT COUNT(*) AS c FROM documents WHERE ${whereSql}`).get(...params);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM documents
         WHERE ${whereSql}
         ORDER BY updated_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, safeLimit, offset);
    return {
      rows,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: Number((total && total.c) || 0),
      },
    };
  }

  update(id, data) {
    const current = this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
    if (!current) return null;

    this.db
      .prepare(
        `UPDATE documents SET
          title = ?,
          doc_type = ?,
          reason = ?,
          proposal_summary = ?,
          current_step = ?,
          status = ?,
          assigned_unit_id = ?,
          assigned_to_id = ?,
          assignment_deadline = ?,
          legal_basis = ?,
          scope = ?,
          applicable_subjects = ?,
          main_content = ?,
          execution_clause = ?,
          review_comment = ?,
          review_result = ?,
          reviewer_id = ?,
          review_at = ?,
          feedback_summary = ?,
          meeting_held = ?,
          meeting_minutes_note = ?,
          explain_receive = ?,
          submit_note = ?,
          signed_confirmed = ?,
          publish_date = ?,
          document_number = ?,
          archived_at = ?,
          expire_date = ?,
          remind_after_days = ?,
          updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        data.title !== undefined ? data.title : current.title,
        data.docType !== undefined ? data.docType : current.doc_type,
        data.reason !== undefined ? data.reason : current.reason,
        data.proposalSummary !== undefined ? data.proposalSummary : current.proposal_summary,
        data.currentStep !== undefined ? data.currentStep : current.current_step,
        data.status !== undefined ? data.status : current.status,
        data.assignedUnitId !== undefined ? data.assignedUnitId : current.assigned_unit_id,
        data.assignedToId !== undefined ? data.assignedToId : current.assigned_to_id,
        data.assignmentDeadline !== undefined ? data.assignmentDeadline : current.assignment_deadline,
        data.legalBasis !== undefined ? data.legalBasis : current.legal_basis,
        data.scope !== undefined ? data.scope : current.scope,
        data.applicableSubjects !== undefined ? data.applicableSubjects : current.applicable_subjects,
        data.mainContent !== undefined ? data.mainContent : current.main_content,
        data.executionClause !== undefined ? data.executionClause : current.execution_clause,
        data.reviewComment !== undefined ? data.reviewComment : current.review_comment,
        data.reviewResult !== undefined ? data.reviewResult : current.review_result,
        data.reviewerId !== undefined ? data.reviewerId : current.reviewer_id,
        data.reviewAt !== undefined ? data.reviewAt : current.review_at,
        data.feedbackSummary !== undefined ? data.feedbackSummary : current.feedback_summary,
        data.meetingHeld !== undefined ? (data.meetingHeld ? 1 : 0) : current.meeting_held,
        data.meetingMinutesNote !== undefined ? data.meetingMinutesNote : current.meeting_minutes_note,
        data.explainReceive !== undefined ? data.explainReceive : current.explain_receive,
        data.submitNote !== undefined ? data.submitNote : current.submit_note,
        data.signedConfirmed !== undefined ? (data.signedConfirmed ? 1 : 0) : current.signed_confirmed,
        data.publishDate !== undefined ? data.publishDate : current.publish_date,
        data.documentNumber !== undefined ? data.documentNumber : current.document_number,
        data.archivedAt !== undefined ? data.archivedAt : current.archived_at,
        data.expireDate !== undefined ? data.expireDate : current.expire_date,
        data.remindAfterDays !== undefined ? data.remindAfterDays : current.remind_after_days,
        id
      );
    return this.findById(id);
  }

  getHistory(documentId) {
    return this.db
      .prepare(
        `SELECT id, document_id, step, action, note, actor_id, actor_name, created_at
         FROM document_history
         WHERE document_id = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(documentId);
  }

  addHistory(documentId, payload) {
    const row = this.db
      .prepare(
        `INSERT INTO document_history(document_id, step, action, note, actor_id, actor_name)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        documentId,
        payload.step,
        payload.action,
        payload.note || null,
        payload.actorId || null,
        payload.actorName || null
      );
    return row.lastInsertRowid;
  }

  addAttachment(documentId, payload) {
    const row = this.db
      .prepare(
        `INSERT INTO document_attachments(
          document_id, step, category, original_name, stored_name, mime_type, file_size, file_path, uploaded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        documentId,
        payload.step,
        payload.category || null,
        payload.originalName,
        payload.storedName,
        payload.mimeType || null,
        payload.fileSize || 0,
        payload.filePath,
        payload.uploadedBy || null
      );
    return row.lastInsertRowid;
  }

  addFeedback(documentId, payload) {
    const row = this.db
      .prepare(`INSERT INTO document_feedback(document_id, author_id, content) VALUES (?, ?, ?)`)
      .run(documentId, payload.authorId || null, payload.content);
    return row.lastInsertRowid;
  }

  getDashboardStats() {
    const byStep = this.db
      .prepare(`SELECT current_step, COUNT(*) AS count FROM documents WHERE deleted_at IS NULL GROUP BY current_step ORDER BY current_step`)
      .all();
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_count,
           SUM(CASE WHEN status = 'archived' OR current_step >= 9 THEN 1 ELSE 0 END) AS completed_count,
           SUM(CASE WHEN status IN ('pending', 'in_progress') AND current_step BETWEEN 1 AND 8 THEN 1 ELSE 0 END) AS in_progress_count,
           SUM(CASE WHEN date(created_at) = date('now','localtime') THEN 1 ELSE 0 END) AS created_today_count
         FROM documents
         WHERE deleted_at IS NULL`
      )
      .get();
    const overdue = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM documents
         WHERE deleted_at IS NULL
           AND assignment_deadline IS NOT NULL
           AND assignment_deadline < date('now')
           AND current_step BETWEEN 2 AND 7
           AND status = 'in_progress'`
      )
      .get();
    return {
      byStep,
      totalCount: Number((totals && totals.total_count) || 0),
      inProgressCount: Number((totals && totals.in_progress_count) || 0),
      completedCount: Number((totals && totals.completed_count) || 0),
      createdTodayCount: Number((totals && totals.created_today_count) || 0),
      overdueCount: Number((overdue && overdue.count) || 0),
    };
  }

  getModuleAdminStats() {
    const users = this.db.prepare(`SELECT COUNT(*) AS c FROM users`).get();
    const processing = this.db
      .prepare(`SELECT COUNT(*) AS c FROM documents WHERE deleted_at IS NULL AND status IN ('pending','in_progress')`)
      .get();
    const overdue = this.db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM documents
         WHERE deleted_at IS NULL
           AND assignment_deadline IS NOT NULL
           AND assignment_deadline < date('now')
           AND status IN ('pending','in_progress')`
      )
      .get();
    const byMonth = this.db
      .prepare(
        `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count
         FROM documents
         WHERE deleted_at IS NULL
         GROUP BY substr(created_at, 1, 7)
         ORDER BY month DESC
         LIMIT 12`
      )
      .all();
    const byType = this.db
      .prepare(`SELECT doc_type, COUNT(*) AS count FROM documents WHERE deleted_at IS NULL GROUP BY doc_type ORDER BY count DESC`)
      .all();
    return {
      usersCount: Number((users && users.c) || 0),
      processingCount: Number((processing && processing.c) || 0),
      overdueCount: Number((overdue && overdue.c) || 0),
      byMonth,
      byType,
    };
  }

  listUsers() {
    const rows = this.db
      .prepare(
        `SELECT id, email, fullname, role, department_id, COALESCE(is_banned,0) AS is_banned, COALESCE(is_active, CASE WHEN COALESCE(is_banned,0)=1 THEN 0 ELSE 1 END) AS is_active
         FROM users
         ORDER BY id DESC`
      )
      .all();
    return (rows || []).map((r) => ({ ...r, role: this.getMergedRoleCsv(r.id, r.role) }));
  }

  getUserById(userId) {
    const row =
      this.db
        .prepare(
          `SELECT id, email, fullname, role, department_id, COALESCE(is_banned,0) AS is_banned, COALESCE(is_active, CASE WHEN COALESCE(is_banned,0)=1 THEN 0 ELSE 1 END) AS is_active
           FROM users WHERE id = ?`
        )
        .get(userId) || null;
    if (!row) return null;
    return { ...row, role: this.getMergedRoleCsv(row.id, row.role) };
  }

  getUserByEmail(email) {
    const row =
      this.db
        .prepare(
          `SELECT id, email, fullname, role, department_id, COALESCE(is_banned,0) AS is_banned, COALESCE(is_active, CASE WHEN COALESCE(is_banned,0)=1 THEN 0 ELSE 1 END) AS is_active
           FROM users WHERE lower(trim(email)) = lower(trim(?))`
        )
        .get(String(email || '').trim()) || null;
    if (!row) return null;
    return { ...row, role: this.getMergedRoleCsv(row.id, row.role) };
  }

  upsertUser(payload) {
    const oldRow = payload.id
      ? this.db.prepare(`SELECT id, role FROM users WHERE id = ?`).get(payload.id)
      : null;
    const roleInput = payload.role != null ? String(payload.role) : '';
    const tokens = DocumentModel.parseRoleTokens(roleInput);
    const systemRole = DocumentModel.pickSystemRole(tokens, oldRow && oldRow.role ? oldRow.role : payload.role);
    if (payload.id) {
      this.db
        .prepare(
          `UPDATE users
           SET email = ?, fullname = ?, role = ?, department_id = ?, is_banned = ?, is_active = ?
           WHERE id = ?`
        )
        .run(
          payload.email,
          payload.fullname || null,
          systemRole,
          payload.department_id || null,
          payload.is_banned ? 1 : 0,
          payload.is_active === false ? 0 : 1,
          payload.id
        );
      this.syncUserWorkflowRoles(payload.id, roleInput);
      return this.getUserById(payload.id);
    }
    const ins = this.db
      .prepare(
        `INSERT INTO users(email, password, fullname, role, department_id, is_banned)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.email,
        payload.password,
        payload.fullname || null,
        systemRole,
        payload.department_id || null,
        payload.is_banned ? 1 : 0
      );
    try {
      this.db
        .prepare(`UPDATE users SET is_active = ? WHERE id = ?`)
        .run(payload.is_active === false ? 0 : 1, ins.lastInsertRowid);
    } catch (_) {}
    this.syncUserWorkflowRoles(ins.lastInsertRowid, roleInput);
    return this.getUserById(ins.lastInsertRowid);
  }

  setUserActive(userId, active) {
    this.db.prepare(`UPDATE users SET is_banned = ?, is_active = ? WHERE id = ?`).run(active ? 0 : 1, active ? 1 : 0, userId);
    return this.getUserById(userId);
  }

  deleteUser(userId) {
    const linkedDocs = this.db
      .prepare(`SELECT COUNT(*) AS c FROM documents WHERE proposer_id = ? OR assigned_to_id = ? OR reviewer_id = ?`)
      .get(userId, userId, userId);
    if (Number((linkedDocs && linkedDocs.c) || 0) > 0) return { deleted: false, reason: 'linked_documents' };
    const r = this.db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
    return { deleted: Number(r.changes || 0) > 0 };
  }

  listModuleManagersAndRoles() {
    const rows = this.db
      .prepare(
        `SELECT id, email, fullname, role, department_id
         FROM users
         WHERE trim(COALESCE(email, '')) <> ''
         ORDER BY fullname COLLATE NOCASE, email COLLATE NOCASE`
      )
      .all();
    return (rows || []).map((r) => ({ ...r, role: this.getMergedRoleCsv(r.id, r.role) }));
  }

  listUnits() {
    return this.db.prepare(`SELECT id, code, name, COALESCE(active,1) AS active FROM units ORDER BY name`).all();
  }

  createUnit(payload) {
    const ins = this.db
      .prepare(`INSERT INTO units(code, name, active) VALUES (?, ?, 1)`)
      .run(payload.code || null, payload.name);
    return this.db.prepare(`SELECT id, code, name, active FROM units WHERE id = ?`).get(ins.lastInsertRowid);
  }

  updateUnit(unitId, payload) {
    this.db
      .prepare(`UPDATE units SET code = ?, name = ?, active = ? WHERE id = ?`)
      .run(payload.code || null, payload.name, payload.active ? 1 : 0, unitId);
    return this.db.prepare(`SELECT id, code, name, active FROM units WHERE id = ?`).get(unitId);
  }

  deleteUnit(unitId) {
    const linkedDocs = this.db
      .prepare(`SELECT COUNT(*) AS c FROM documents WHERE assigned_unit_id = ?`)
      .get(unitId);
    const linkedUsers = this.db
      .prepare(`SELECT COUNT(*) AS c FROM users WHERE department_id = (SELECT code FROM units WHERE id = ?)`)
      .get(unitId);
    if (Number((linkedDocs && linkedDocs.c) || 0) > 0 || Number((linkedUsers && linkedUsers.c) || 0) > 0) {
      return { deleted: false, reason: 'linked_data' };
    }
    const r = this.db.prepare(`DELETE FROM units WHERE id = ?`).run(unitId);
    return { deleted: Number(r.changes || 0) > 0 };
  }

  listDocumentTypes() {
    return this.db
      .prepare(`SELECT id, code, name, is_active, sort_order FROM document_types ORDER BY sort_order, id`)
      .all();
  }

  upsertDocumentType(payload) {
    if (payload.id) {
      this.db
        .prepare(
          `UPDATE document_types
           SET code = ?, name = ?, is_active = ?, sort_order = ?, updated_by = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(
          payload.code,
          payload.name,
          payload.is_active ? 1 : 0,
          payload.sort_order || 0,
          payload.updated_by || null,
          payload.id
        );
      return this.db.prepare(`SELECT * FROM document_types WHERE id = ?`).get(payload.id);
    }
    const ins = this.db
      .prepare(
        `INSERT INTO document_types(code, name, is_active, sort_order, updated_by)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        payload.code,
        payload.name,
        payload.is_active ? 1 : 0,
        payload.sort_order || 0,
        payload.updated_by || null
      );
    return this.db.prepare(`SELECT * FROM document_types WHERE id = ?`).get(ins.lastInsertRowid);
  }

  getModuleSettings() {
    const rows = this.db.prepare(`SELECT setting_key, setting_value FROM module_settings`).all();
    const out = {};
    rows.forEach((r) => {
      out[r.setting_key] = r.setting_value;
    });
    return out;
  }

  setModuleSetting(key, value, userId) {
    this.db
      .prepare(
        `INSERT INTO module_settings(setting_key, setting_value, updated_by, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(setting_key) DO UPDATE SET
           setting_value = excluded.setting_value,
           updated_by = excluded.updated_by,
           updated_at = datetime('now')`
      )
      .run(key, value, userId || null);
  }

  addAuditLog(payload) {
    this.db
      .prepare(
        `INSERT INTO audit_logs(user_id, action, target_type, target_id, old_value, new_value, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.user_id || null,
        payload.action,
        payload.target_type || null,
        payload.target_id || null,
        payload.old_value || null,
        payload.new_value || null,
        payload.ip_address || null,
        payload.user_agent || null
      );
  }

  listAuditLogs(filters = {}) {
    const where = ['1=1'];
    const params = [];
    if (filters.userId) {
      where.push('a.user_id = ?');
      params.push(Number(filters.userId));
    }
    if (filters.action) {
      where.push('a.action = ?');
      params.push(String(filters.action));
    }
    if (filters.from) {
      where.push('a.created_at >= ?');
      params.push(String(filters.from));
    }
    if (filters.to) {
      where.push('a.created_at <= ?');
      params.push(String(filters.to));
    }
    return this.db
      .prepare(
        `SELECT a.*, u.email AS user_email, u.fullname AS user_fullname
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE ${where.join(' AND ')}
         ORDER BY a.id DESC
         LIMIT 500`
      )
      .all(...params);
  }

  softDeleteDocument(id) {
    this.db.prepare(`UPDATE documents SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
    return this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) || null;
  }
}

module.exports = DocumentModel;
