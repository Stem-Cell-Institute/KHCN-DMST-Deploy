/**
 * Khởi tạo schema thiết bị và gắn các module con: equipment, ngân hàng tế bào, văn bản nội bộ, phân quyền dashboard, DMS, phân tích công bố.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const fs = require('fs');
const appPaths = require('../lib/appPaths');
const jwt = require('jsonwebtoken');
const db = require('../lib/db-bridge');

module.exports = function mountSubModulesAndAnalytics({
  JWT_SECRET,
  adminOnly,
  app,
  authMiddleware,
  authUnlessDashboardPermCheck,
  getSmtpFrom,
  getTokenFromReq,
  insertUserActivityLog,
  masterAdminOnly,
  optionalAuthMiddleware,
  reqIsMasterAdmin,
  transporter,
  userEmailIsMasterAdmin,
  userIdIsBanned,
  rootDir,
}) {
  try {
    const createEquipmentAnalyticsRouter = require('../routes/equipmentAnalytics');
    app.use('/api/equipment-analytics', authMiddleware, adminOnly, createEquipmentAnalyticsRouter({ db }));
    console.log('[CRD] Đã mount /api/equipment-analytics (admin)');
  } catch (e) {
    console.warn('[CRD] Không mount equipment-analytics:', e.message);
  }

  /** Quản trị thiết bị (hồ sơ, PDF, video, QR) — db/equipment_schema.sql */
  try {
    const equipmentSchemaPath = path.join(rootDir, 'db', 'equipment_schema.sql');
    if (fs.existsSync(equipmentSchemaPath)) {
      db.exec(fs.readFileSync(equipmentSchemaPath, 'utf8'));
    }
  } catch (e) {
    console.warn('[db/equipment_schema]', e.message);
  }
  try {
    db.prepare('ALTER TABLE users ADD COLUMN department_id TEXT').run();
  } catch (e) {
    /* đã có cột */
  }

  try {
    const equipmentP2 = path.join(rootDir, 'db', 'equipment_prompt2.sql');
    if (fs.existsSync(equipmentP2)) {
      db.exec(fs.readFileSync(equipmentP2, 'utf8'));
    }
  } catch (e) {
    console.warn('[db/equipment_prompt2]', e.message);
  }
  (function equipmentPrompt2Alters() {
    const alters = [
      'ALTER TABLE equipments ADD COLUMN asset_group TEXT',
      'ALTER TABLE equipments ADD COLUMN created_by INTEGER REFERENCES users(id)',
      'ALTER TABLE equipments ADD COLUMN last_maintenance_date TEXT',
      'ALTER TABLE equipments ADD COLUMN next_maintenance_date TEXT',
      'ALTER TABLE equipments ADD COLUMN calibration_due_date TEXT',
      'ALTER TABLE equipments ADD COLUMN asset_type_code TEXT',
      'ALTER TABLE equipments ADD COLUMN year_in_use INTEGER',
      'ALTER TABLE equipments ADD COLUMN unit_name TEXT',
      'ALTER TABLE equipments ADD COLUMN quantity_book REAL',
      'ALTER TABLE equipments ADD COLUMN quantity_actual REAL',
      'ALTER TABLE equipments ADD COLUMN quantity_diff REAL',
      'ALTER TABLE equipments ADD COLUMN remaining_value REAL',
      'ALTER TABLE equipments ADD COLUMN utilization_note TEXT',
      'ALTER TABLE equipments ADD COLUMN condition_note TEXT',
      'ALTER TABLE equipments ADD COLUMN disaster_impact_note TEXT',
      'ALTER TABLE equipments ADD COLUMN construction_asset_note TEXT',
      'ALTER TABLE equipments ADD COLUMN usage_count_note TEXT',
      'ALTER TABLE equipments ADD COLUMN land_attached_note TEXT',
      'ALTER TABLE equipments ADD COLUMN asset_note TEXT',
      'ALTER TABLE equipment_documents ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE equipment_documents ADD COLUMN supersedes_id INTEGER REFERENCES equipment_documents(id)',
      "ALTER TABLE equipment_videos ADD COLUMN thumbnail_url TEXT",
      'ALTER TABLE equipments ADD COLUMN deleted_at TEXT',
      'ALTER TABLE equipments ADD COLUMN deleted_by INTEGER REFERENCES users(id)',
    ];
    for (const sql of alters) {
      try {
        db.prepare(sql).run();
      } catch (e) {
        /* đã có cột */
      }
    }
    try {
      db.exec(`
      CREATE TABLE IF NOT EXISTS equipment_code_sequences (
        dept_code TEXT NOT NULL,
        year INTEGER NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (dept_code, year)
      );
      CREATE TABLE IF NOT EXISTS equipment_loans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id INTEGER NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
        borrower_id INTEGER REFERENCES users(id),
        borrower_name TEXT,
        purpose TEXT,
        borrowed_at TEXT DEFAULT (datetime('now')),
        expected_return_at TEXT,
        returned_at TEXT,
        return_note TEXT,
        created_by INTEGER REFERENCES users(id),
        returned_by INTEGER REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_equipment_loans_equipment ON equipment_loans(equipment_id);
      CREATE INDEX IF NOT EXISTS idx_equipment_loans_open ON equipment_loans(equipment_id, returned_at);
    `);
    } catch (e) {
      console.warn('[equipment extra tables]', e.message);
    }
  })();

  (function dropLegacyEquipmentReviewColumns() {
    try {
      const cols = db.prepare(`PRAGMA table_info(equipments)`).all();
      if (!cols || !cols.length) return;
      const names = new Set(cols.map((c) => String(c.name || '')));
      const legacyCols = ['review_status', 'published_at', 'review_rejection_note'];
      const hasLegacy = legacyCols.some((c) => names.has(c));
      if (!hasLegacy) return;

      const keepCols = [
        'id',
        'equipment_code',
        'name',
        'asset_group',
        'model',
        'serial_number',
        'manufacturer',
        'purchase_year',
        'purchase_value',
        'department_id',
        'manager_id',
        'location',
        'specs_json',
        'status',
        'profile_visibility',
        'created_by',
        'last_maintenance_date',
        'next_maintenance_date',
        'calibration_due_date',
        'asset_type_code',
        'year_in_use',
        'unit_name',
        'quantity_book',
        'quantity_actual',
        'quantity_diff',
        'remaining_value',
        'utilization_note',
        'condition_note',
        'disaster_impact_note',
        'construction_asset_note',
        'usage_count_note',
        'land_attached_note',
        'asset_note',
        'created_at',
        'updated_at',
      ].filter((c) => names.has(c));
      if (!keepCols.length) return;
      const keepSql = keepCols.join(', ');

      db.exec('BEGIN IMMEDIATE');
      db.exec(`
      CREATE TABLE __equipments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        asset_group TEXT,
        model TEXT,
        serial_number TEXT,
        manufacturer TEXT,
        purchase_year INTEGER,
        purchase_value REAL,
        department_id TEXT,
        manager_id INTEGER REFERENCES users(id),
        location TEXT,
        specs_json TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','maintenance','broken','retired')),
        profile_visibility TEXT NOT NULL DEFAULT 'institute' CHECK(profile_visibility IN ('public','institute','internal')),
        created_by INTEGER REFERENCES users(id),
        last_maintenance_date TEXT,
        next_maintenance_date TEXT,
        calibration_due_date TEXT,
        asset_type_code TEXT,
        year_in_use INTEGER,
        unit_name TEXT,
        quantity_book REAL,
        quantity_actual REAL,
        quantity_diff REAL,
        remaining_value REAL,
        utilization_note TEXT,
        condition_note TEXT,
        disaster_impact_note TEXT,
        construction_asset_note TEXT,
        usage_count_note TEXT,
        land_attached_note TEXT,
        asset_note TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
      db.exec(`INSERT INTO __equipments_new (${keepSql}) SELECT ${keepSql} FROM equipments`);
      db.exec(`DROP TABLE equipments`);
      db.exec(`ALTER TABLE __equipments_new RENAME TO equipments`);
      db.exec('COMMIT');
      console.log('[EQUIP] dropped legacy review columns from equipments');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {}
      console.warn('[EQUIP] drop legacy review columns:', e.message);
    }
  })();

  (function migrateEquipmentUsageAndConditionCodes() {
    function stripVietnamese(s) {
      return String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    }
    function normalizeCode(v) {
      if (v == null) return null;
      const raw = String(v).trim();
      if (!raw) return null;
      const m = raw.match(/^([0-3])(?:\s*[:\-].*)?$/);
      if (m) return m[1];
      const key = stripVietnamese(raw).replace(/[^a-z0-9]+/g, ' ').trim();
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
    try {
      const rows = db
        .prepare(
          `SELECT id, utilization_note, condition_note
         FROM equipments
         WHERE utilization_note IS NOT NULL OR condition_note IS NOT NULL`
        )
        .all();
      if (!rows || !rows.length) return;
      const upd = db.prepare(
        `UPDATE equipments
       SET utilization_note = ?, condition_note = ?, updated_at = datetime('now')
       WHERE id = ?`
      );
      let changed = 0;
      db.exec('BEGIN IMMEDIATE');
      for (const r of rows) {
        const u0 = r.utilization_note == null ? null : String(r.utilization_note);
        const c0 = r.condition_note == null ? null : String(r.condition_note);
        const u1 = normalizeCode(u0);
        const c1 = normalizeCode(c0);
        if (u1 !== u0 || c1 !== c0) {
          upd.run(u1, c1, r.id);
          changed += 1;
        }
      }
      db.exec('COMMIT');
      if (changed > 0) console.log('[EQUIP] normalized utilization/condition codes:', changed);
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {}
      console.warn('[EQUIP] migrate codes:', e.message);
    }
  })();

  try {
    const createEquipmentRouter = require('../routes/equipment');
    const equipmentUploadsDir = appPaths.equipmentUploadsDir();
    fs.mkdirSync(equipmentUploadsDir, { recursive: true });
    function equipmentMailSend(opts) {
      if (!transporter || !opts) return Promise.resolve({ ok: false, reason: 'mail_not_configured' });
      const toList = Array.isArray(opts.to) ? opts.to.filter(Boolean) : opts.to ? [opts.to] : [];
      if (!toList.length) return Promise.resolve({ ok: false, reason: 'no_recipients' });
      const to = toList.join(', ');
      return transporter
        .sendMail({
          from: getSmtpFrom(),
          to,
          subject: opts.subject || 'Thông báo thiết bị',
          text: opts.text || '',
          html: opts.html || opts.text || '',
        })
        .then(() => ({ ok: true }))
        .catch((e) => {
          console.warn('[EQUIP mail]', e.message);
          return { ok: false, reason: 'smtp_error', error: 'smtp_error' };
        });
    }

    app.use(
      '/api/equipment',
      createEquipmentRouter({
        db,
        authMiddleware,
        adminOnly,
        getTokenFromReq,
        jwt,
        JWT_SECRET,
        userIdIsBanned,
        isMasterAdmin: reqIsMasterAdmin,
        uploadsEquipmentRoot: equipmentUploadsDir,
        uploadsRoot: appPaths.uploadsRoot(),
        equipmentMailSend,
      })
    );
    console.log('[EQUIP] Đã mount /api/equipment');
  } catch (e) {
    console.warn('[EQUIP] Không mount equipment:', e.message);
  }

  /** Ngân hàng Tế bào & Kháng thể — routes/nganHangTeBaoKhangThe.js (bảng nhm_*, chuyển hướng địa chỉ cũ, API) */
  try {
    require('../routes/nganHangTeBaoKhangThe').mount(app, { db, authMiddleware, insertUserActivityLog, baseUrl: process.env.BASE_URL || '', nhacTuDong: true, mailSend: (o) => (transporter ? transporter.sendMail({ from: getSmtpFrom(), ...o }) : Promise.reject(new Error('mail_not_configured'))) });
    console.log('[NGAN-HANG] Đã mount /api/ngan-hang-te-bao-khang-the');
  } catch (e) {
    console.warn('[NGAN-HANG] Không mount ngan-hang-te-bao-khang-the:', e.message);
  }

  /** Quy trình ban hành văn bản hành chính nội bộ (9 bước) */
  try {
    const createInternalDocumentsWorkflowRouter = require('../routes/internalDocumentsWorkflow');
    function documentWorkflowMailSend(opts) {
      if (!transporter || !opts) return Promise.resolve({ ok: false, reason: 'mail_not_configured' });
      const toList = Array.isArray(opts.to) ? opts.to.filter(Boolean) : opts.to ? [opts.to] : [];
      if (!toList.length) return Promise.resolve({ ok: false, reason: 'no_recipients' });
      return transporter
        .sendMail({
          from: getSmtpFrom(),
          to: toList.join(', '),
          subject: opts.subject || 'Thông báo quy trình văn bản',
          text: opts.text || '',
          html: opts.html || opts.text || '',
        })
        .then(() => ({ ok: true }))
        .catch((e) => {
          console.warn('[DOCFLOW mail]', e.message);
          return { ok: false, reason: 'smtp_error', error: 'smtp_error' };
        });
    }
    const internalWorkflowRouter = createInternalDocumentsWorkflowRouter({
      db,
      authMiddleware,
      uploadsRoot: appPaths.uploadsRoot(),
      mailSend: documentWorkflowMailSend,
      baseUrl: process.env.BASE_URL || '',
    });
    // Alias tương thích ngược cho bundle React cũ (trước khi đổi prefix /api/admin -> /api/docflow-admin).
    // Chỉ bắc cầu những path KHÔNG đụng với các handler /api/admin/* có sẵn của server.js (đặc biệt
    // KHÔNG đụng /api/admin/users — handler cũ trả schema khác, sẽ bị phá nếu alias).
    //
    // Middleware này rewrite req.url trước khi chạm internalWorkflowRouter, nên phải đứng TRƯỚC
    // `app.use('/api', internalWorkflowRouter)` bên dưới.
    const DOCFLOW_ADMIN_LEGACY_PREFIXES = [
      '/api/admin/module/',
      '/api/admin/module-permissions',
      '/api/admin/module-settings',
      '/api/admin/audit-logs',
      '/api/admin/dashboard',
      '/api/admin/units',
      '/api/admin/units/',
      '/api/admin/email-notifications',
      '/api/admin/document-types',
      '/api/admin/document-types/',
    ];
    let warnedDocflowStaleBundle = false;
    app.use((req, _res, next) => {
      try {
        const p = req.path || '';
        if (!DOCFLOW_ADMIN_LEGACY_PREFIXES.some((prefix) => p === prefix.replace(/\/$/, '') || p.startsWith(prefix))) {
          return next();
        }
        if (!warnedDocflowStaleBundle) {
          warnedDocflowStaleBundle = true;
          console.warn(
            '[DOCFLOW] Client gọi /api/admin/* (bundle React cũ) — đã alias sang /api/docflow-admin/*.\n' +
              '          Triển khai bundle mới: git pull + restart Node (server sẽ auto rebuild dist).'
          );
        }
        // /api/admin/<rest> -> /api/docflow-admin/<rest>
        req.url = req.url.replace(/^\/api\/admin(\/|$)/, '/api/docflow-admin$1');
      } catch (_) {
        /* noop */
      }
      return next();
    });

    app.use('/api', internalWorkflowRouter);
    console.log('[DOCFLOW] Đã mount /api/documents, /api/attachments, /api/units, /api/dashboard/stats, /api/docflow-admin/*');
    console.log('[DOCFLOW] Alias sẵn sàng cho bundle cũ: /api/admin/{module|module-*|dashboard|units|audit-logs|email-notifications|document-types} -> /api/docflow-admin/*');
  } catch (e) {
    console.warn('[DOCFLOW] Không mount internal documents workflow:', e.message);
  }

  /** Bảng dashboard_permissions (migrations/004_dashboard_permissions.sql) */
  try {
    const dashPermSql = path.join(rootDir, 'migrations', '004_dashboard_permissions.sql');
    if (fs.existsSync(dashPermSql)) {
      db.exec(fs.readFileSync(dashPermSql, 'utf8'));
    }
  } catch (e) {
    console.warn('[migrations/004_dashboard_permissions]', e.message);
  }

  /** Nhật ký truy cập dashboard (migrations/005_dashboard_access_log.sql) */
  try {
    const dashLogSql = path.join(rootDir, 'migrations', '005_dashboard_access_log.sql');
    if (fs.existsSync(dashLogSql)) {
      db.exec(fs.readFileSync(dashLogSql, 'utf8'));
    }
  } catch (e) {
    console.warn('[migrations/005_dashboard_access_log]', e.message);
  }

  try {
    const rowMode = db.prepare('SELECT 1 FROM system_settings WHERE key = ?').get('pub_analytics_access_mode');
    if (!rowMode) {
      db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)').run(
        'pub_analytics_access_mode',
        'whitelist'
      );
    }
    const rowSuf = db.prepare('SELECT 1 FROM system_settings WHERE key = ?').get('pub_analytics_email_suffix');
    if (!rowSuf) {
      db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)').run('pub_analytics_email_suffix', '@sci.edu.vn');
    }
    const rowSufVal = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('pub_analytics_email_suffix');
    if (rowSufVal && String(rowSufVal.value || '').toLowerCase() === '@sci.edu') {
      db.prepare('UPDATE system_settings SET value = ? WHERE key = ?').run('@sci.edu.vn', 'pub_analytics_email_suffix');
    }
  } catch (e) {
    console.warn('[system_settings pub_analytics]', e.message);
  }

  /** CRUD quyền xem dashboard — routes/dashboardPermissions.js */
  try {
    const createDashboardPermissionsRouter = require('../routes/dashboardPermissions');
    app.use(
      '/api/dashboard-perms',
      authUnlessDashboardPermCheck,
      createDashboardPermissionsRouter({
        db,
        isMasterAdmin: reqIsMasterAdmin,
        isUserMasterAdmin: (u) => userEmailIsMasterAdmin(u && u.email),
      })
    );
    console.log('[DASH] Đã mount /api/dashboard-perms');
  } catch (e) {
    console.warn('[DASH] Không mount dashboard-perms:', e.message);
  }

  /** Quản lý tài liệu & hồ sơ (hành chính) — /api/dms */
  try {
    const createDmsRecordsRouter = require('../routes/dmsRecords');
    const dmsUploadsRoot = appPaths.dmsUploadsDir();
    app.use(
      '/api/dms',
      authMiddleware,
      createDmsRecordsRouter({
        db,
        adminOnly,
        masterAdminOnly,
        isMasterAdmin: reqIsMasterAdmin,
        uploadsDir: dmsUploadsRoot,
      })
    );
    console.log('[DMS] Đã mount /api/dms');
  } catch (e) {
    console.warn('[DMS] Không mount /api/dms:', e.message);
  }

  /** Thống kê công bố — theo chính sách pub_analytics (whitelist / nội bộ / STIMS / public) */
  try {
    const createPublicationAnalyticsRouter = require('../routes/publicationAnalytics');
    const { createCheckPubAnalyticsAccess } = require('../middleware/pubAnalyticsAccess');
    const checkPubAnalytics = createCheckPubAnalyticsAccess(db, {
      isUserMasterAdmin: (u) => userEmailIsMasterAdmin(u && u.email),
    });
    app.use('/api/pub-analytics', optionalAuthMiddleware, checkPubAnalytics, createPublicationAnalyticsRouter({ db }));
    console.log('[PUB] Đã mount /api/pub-analytics (chính sách truy cập dashboard)');
  } catch (e) {
    console.warn('[PUB] Không mount pub-analytics:', e.message);
  }
};
