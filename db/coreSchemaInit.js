/**
 * Khởi tạo schema lõi (users, submissions, missions, publications, cooperation, events, htqt) và chạy migrations.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../lib/db-bridge');

module.exports = function initCoreDatabaseSchema({ insertCapVienHistory }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    fullname TEXT,
    role TEXT DEFAULT 'researcher',
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    submittedBy TEXT NOT NULL,
    submittedById INTEGER,
    status TEXT DEFAULT 'SUBMITTED',
    createdAt TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (submittedById) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS submission_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    fieldName TEXT NOT NULL,
    originalName TEXT NOT NULL,
    path TEXT NOT NULL,
    FOREIGN KEY (submissionId) REFERENCES submissions(id)
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notification_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    fullname TEXT,
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS homepage_modules (
    code TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    enabled INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS user_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    email TEXT,
    action TEXT NOT NULL,
    module TEXT,
    path TEXT,
    detail TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);
  try {
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_activity_log_created ON user_activity_log(created_at DESC)').run();
  } catch (e) {}
  try {
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_activity_log_user ON user_activity_log(user_id)').run();
  } catch (e) {}
  try {
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_activity_log_action ON user_activity_log(action)').run();
  } catch (e) {}

  try {
    require('../database/migrations/add_ticker')(db);
  } catch (e) {
    console.error('[Ticker migration]', e.message || e);
  }
  try {
    require('../database/migrations/add_conference_registrations')(db);
  } catch (e) {
    console.error('[Conference registrations migration]', e.message || e);
  }
  try {
    require('../database/migrations/add_homepage_sidebar_rss')(db);
  } catch (e) {
    console.error('[Homepage sidebar RSS migration]', e.message || e);
  }
  try {
    require('../database/migrations/add_homepage_sidebar_rss_html_scrape')(db);
    require('../database/migrations/add_homepage_news_strip_display')(db);
  } catch (e) {
    console.error('[Homepage sidebar RSS HTML scrape migration]', e.message || e);
  }
  try {
    require('../database/migrations/add_cooperation_thoa_thuan_open_term')(db);
  } catch (e) {
    console.error('[Cooperation thoa thuan open-term migration]', e.message || e);
  }

  (function backfillCapVienHistory() {
    const allSubs = db.prepare('SELECT id, status, createdAt, submittedById, reviewedAt, reviewedById, reviewNote, assignedAt, assignedById, assignedReviewerIds FROM cap_vien_submissions').all();
    for (const sub of allSubs) {
      const hasStep1 = db.prepare('SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = ? LIMIT 1').get(sub.id, '1');
      if (!hasStep1 && sub.createdAt && sub.submittedById) {
        insertCapVienHistory(sub.id, '1', 'researcher_submit', sub.submittedById, 'researcher', 'Nghiên cứu viên nộp hồ sơ đề xuất', sub.createdAt);
      }
      const hasStep2 = db.prepare('SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = ? LIMIT 1').get(sub.id, '2');
      if (!hasStep2 && sub.reviewedAt && sub.reviewedById) {
        const u = db.prepare('SELECT fullname, role FROM users WHERE id = ?').get(sub.reviewedById);
        const performedByName = u ? (u.fullname || '') : '';
        const role = (u && u.role === 'admin') ? 'admin' : 'secretary';
        const actionType = (sub.status || '').toUpperCase() === 'VALIDATED' ? 'secretary_approve' : 'secretary_request_revision';
        const note = sub.reviewNote || (actionType === 'secretary_approve' ? 'Hợp lệ' : null);
        insertCapVienHistory(sub.id, '2', actionType, sub.reviewedById, role, note, sub.reviewedAt);
        const existingStep2 = db.prepare('SELECT 1 FROM cap_vien_step2_history WHERE submissionId = ? LIMIT 1').get(sub.id);
        if (!existingStep2) {
          db.prepare(
            'INSERT INTO cap_vien_step2_history (submissionId, actionType, performedAt, performedById, performedByName, performedByRole, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(sub.id, actionType, sub.reviewedAt, sub.reviewedById, performedByName, role, note);
        }
      }
      const hasStep3 = db.prepare('SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = ? LIMIT 1').get(sub.id, '3');
      if (!hasStep3 && sub.assignedAt && sub.assignedById) {
        const reviewerIds = (() => { try { return JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) { return []; } })();
        const names = reviewerIds.length ? db.prepare('SELECT fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds).map(r => r.fullname || '') : [];
        insertCapVienHistory(sub.id, '3', 'chairman_assign', sub.assignedById, 'chairman', 'Phân công 2 phản biện: ' + names.join(', '), sub.assignedAt);
      }
    }
  })();

    try {
      db.prepare("ALTER TABLE submissions ADD COLUMN status TEXT DEFAULT 'SUBMITTED'").run();
    } catch (e) { /* column đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN reviewNote TEXT').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN reviewedAt TEXT').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN reviewedById INTEGER').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN assignedReviewerIds TEXT').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN assignedAt TEXT').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN assignedById INTEGER').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN assignNote TEXT').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submission_files ADD COLUMN uploadedAt TEXT').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN meetingNote TEXT').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN meetingDecisionAt TEXT').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN meetingDecisionById INTEGER').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN conditionalSubmittedAt TEXT').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN conditionalSubmittedById INTEGER').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN conditionalApprovedAt TEXT').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN conditionalApprovedById INTEGER').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN decisionIssuedAt TEXT').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN decisionIssuedById INTEGER').run();
    } catch (e) { /* đã tồn tại */ }
    try {
      db.prepare('ALTER TABLE submissions ADD COLUMN completedAt TEXT').run();
    } catch (e) { /* đã tồn tại */ }
    db.exec(`
    CREATE TABLE IF NOT EXISTS submission_gd5_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submissionId INTEGER NOT NULL,
      actionType TEXT NOT NULL,
      performedAt TEXT NOT NULL,
      performedById INTEGER,
      performedByName TEXT,
      fileFieldName TEXT,
      originalFileName TEXT,
      label TEXT,
      FOREIGN KEY (submissionId) REFERENCES submissions(id)
    )
  `);

  // Bảng nhiệm vụ KHCN (dashboard): trích xuất từ đề tài các cấp, đồng bộ từ cap_vien
  db.exec(`
  CREATE TABLE IF NOT EXISTS missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    principal TEXT,
    level TEXT NOT NULL,
    status TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    progress INTEGER DEFAULT 0,
    budget REAL,
    source_id INTEGER,
    source_type TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_missions_level ON missions(level)').run(); } catch (e) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status)').run(); } catch (e) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_missions_dates ON missions(start_date, end_date)').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN managing_agency TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN contract_number TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN funding_source TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN approved_budget REAL').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN disbursed_budget REAL').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN disbursement_year TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN cooperating_units TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN mission_type TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN field TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN objectives TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_trang_thai TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_nguoi_xet_duyet_id INTEGER').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_ngay_gui TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_ngay_phan_hoi TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_ket_qua TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_dieu_kien TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_nhan_xet_khoa_hoc TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_nhan_xet_kha_thi TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_nhan_xet_dinh_huong TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_nhan_xet_nang_luc TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_ly_do_tu_choi TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_lan_xet_thu INTEGER DEFAULT 1').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_file_phieu_nhan_xet TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN nhanh TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN principal_hoc_vi TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN principal_don_vi TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN principal_orcid TEXT').run(); } catch (e) {}
  try { db.prepare('ALTER TABLE missions ADD COLUMN lan_phan_nhanh INTEGER DEFAULT 1').run(); } catch (e) {}
  db.exec(`
  CREATE TABLE IF NOT EXISTS lich_su_buoc3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    lan_xet INTEGER NOT NULL DEFAULT 1,
    nguoi_xet_id INTEGER,
    ngay_xet TEXT,
    ket_qua TEXT,
    nhan_xet_json TEXT,
    dieu_kien TEXT,
    ly_do_tu_choi TEXT,
    file_phieu_pdf TEXT,
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_lich_su_buoc3_mission ON lich_su_buoc3(mission_id)').run(); } catch (e) {}
  db.exec(`
  CREATE TABLE IF NOT EXISTS missions_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS missions_hidden (
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    PRIMARY KEY (source_type, source_id)
  )
`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS missions_ho_so_ngoai (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    submission_date TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_missions_ho_so_ngoai_mission ON missions_ho_so_ngoai(mission_id)').run(); } catch (e) {}

  // Bước 4 Nhánh A — Xét chọn tại Viện & gửi Bộ
  db.exec(`
  CREATE TABLE IF NOT EXISTS buoc4a (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL UNIQUE,
    hop_trang_thai TEXT DEFAULT 'chua_len_lich',
    hop_ngay TEXT,
    hop_hinh_thuc TEXT,
    hop_dia_diem TEXT,
    hop_link TEXT,
    thanh_phan_ids TEXT,
    ghi_chu TEXT,
    ngay_hop_thuc_te TEXT,
    hd_ket_luan TEXT,
    noi_dung_chinh_sua TEXT,
    han_chinh_sua TEXT,
    ly_do TEXT,
    nhan_xet TEXT,
    bien_ban_file_id INTEGER,
    thuyet_minh_chinh_sua_ok INTEGER DEFAULT 0,
    trang_thai TEXT DEFAULT 'chua_hop',
    lan_xet_thu INTEGER DEFAULT 1,
    co_quan_nhan TEXT,
    danh_muc_file_id INTEGER,
    ngay_gui TEXT,
    hinh_thuc_gui TEXT,
    nguoi_nhan TEXT,
    gui_ghi_chu TEXT,
    ngay_nhan_ket_qua TEXT,
    ket_qua_bo TEXT,
    bo_noi_dung_yc TEXT,
    bo_han_yc TEXT,
    bo_ly_do TEXT,
    van_ban_bo_file_id INTEGER,
    ket_qua_ghi_chu TEXT,
    lan_gui_thu INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_buoc4a_mission ON buoc4a(mission_id)').run(); } catch (e) {}

  db.exec(`
  CREATE TABLE IF NOT EXISTS lich_su_buoc4a (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    buoc_so INTEGER DEFAULT 4,
    sub_buoc TEXT,
    action TEXT NOT NULL,
    user_id INTEGER,
    timestamp TEXT DEFAULT (datetime('now')),
    data_snapshot TEXT,
    ip_address TEXT,
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_lich_su_buoc4a_mission ON lich_su_buoc4a(mission_id)').run(); } catch (e) {}

  // Bước 4 Nhánh B — Nộp cơ quan ngoài
  db.exec(`
  CREATE TABLE IF NOT EXISTS buoc4b (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL UNIQUE,
    co_quan_nhan TEXT,
    han_nop TEXT,
    ngay_nop_thuc_te TEXT,
    hinh_thuc_nop TEXT,
    ma_ho_so TEXT,
    ghi_chu TEXT,
    trang_thai TEXT DEFAULT 'chua_nop',
    ngay_du_kien_ket_qua TEXT,
    ket_qua TEXT,
    noi_dung_yc TEXT,
    han_yc TEXT,
    ly_do TEXT,
    van_ban_file_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_buoc4b_mission ON buoc4b(mission_id)').run(); } catch (e) {}

  // Lịch sử đổi nhánh (reset về Bước 3)
  db.exec(`
  CREATE TABLE IF NOT EXISTS lich_su_doi_nhanh (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    nhanh_cu TEXT NOT NULL,
    nhanh_moi TEXT NOT NULL,
    cap_cu TEXT,
    cap_moi TEXT,
    ly_do TEXT NOT NULL,
    reset_boi INTEGER,
    reset_luc TEXT DEFAULT (datetime('now')),
    buoc4_snapshot TEXT,
    FOREIGN KEY (mission_id) REFERENCES missions(id),
    FOREIGN KEY (reset_boi) REFERENCES users(id)
  )
`);
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_lich_su_doi_nhanh_mission ON lich_su_doi_nhanh(mission_id)').run(); } catch (e) {}

  // Lịch sử hành động các bước (generic)
  db.exec(`
  CREATE TABLE IF NOT EXISTS lich_su_buoc (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    user_id INTEGER,
    timestamp TEXT DEFAULT (datetime('now')),
    note TEXT,
    FOREIGN KEY (mission_id) REFERENCES missions(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_lich_su_buoc_mission ON lich_su_buoc(mission_id)').run(); } catch (e) {}

  // Bước 5 — Chờ phê duyệt chính thức & hoàn chỉnh thuyết minh
  db.exec(`
  CREATE TABLE IF NOT EXISTS buoc5 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL UNIQUE,
    trang_thai TEXT DEFAULT 'cho_hoan_chinh',
    bo_yeu_cau_chinh_sua TEXT,
    so_qd TEXT,
    ngay_ky_qd TEXT,
    co_quan_ky TEXT,
    qd_file_id INTEGER,
    ma_de_tai_chinh_thuc TEXT,
    kinh_phi REAL,
    thoi_gian_bd TEXT,
    thoi_gian_kt TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_buoc5_mission ON buoc5(mission_id)').run(); } catch (e) {}

  db.exec(`
  CREATE TABLE IF NOT EXISTS buoc5_thuyet_minh_ls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    phien_ban TEXT,
    ghi_chu TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    user_id INTEGER,
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_buoc5_tm_mission ON buoc5_thuyet_minh_ls(mission_id)').run(); } catch (e) {}

  // Bước 6 — Ký hợp đồng
  db.exec(`
  CREATE TABLE IF NOT EXISTS buoc6 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL UNIQUE,
    so_hd_ngoai TEXT,
    ngay_ky_ngoai TEXT,
    gia_tri_hd REAL,
    file_hd_ngoai_id INTEGER,
    so_hd_noi_bo TEXT,
    ngay_ky_noi_bo TEXT,
    file_hd_noi_bo_id INTEGER,
    phi_quan_ly REAL,
    phi_override INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_buoc6_mission ON buoc6(mission_id)').run(); } catch (e) {}

  db.exec(`
  CREATE TABLE IF NOT EXISTS missions_templates (
    template_type TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

  db.exec(`
  CREATE TABLE IF NOT EXISTS ace_templates (
    template_type TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

  // Bảng placeholder cho thống kê trang chủ (khi có module tương ứng sẽ thêm cột và dữ liệu)
  db.exec(`CREATE TABLE IF NOT EXISTS personnel (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS ip_assets (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS publications (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
  try {
    db.prepare('ALTER TABLE publications ADD COLUMN import_source TEXT DEFAULT NULL').run();
  } catch (e) {
    /* cột đã tồn tại */
  }
  db.exec(`CREATE TABLE IF NOT EXISTS cooperation (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_notification_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    fullname TEXT,
    topics TEXT DEFAULT 'all',
    createdAt TEXT DEFAULT (datetime('now'))
  )
`);
    try { db.prepare('ALTER TABLE cooperation_notification_recipients ADD COLUMN topics TEXT DEFAULT \'all\'').run(); } catch (e) { /* đã có cột */ }
    try { db.prepare('ALTER TABLE cooperation_notification_recipients ADD COLUMN role TEXT').run(); } catch (e) { /* đã có cột */ }
    try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN quoc_gia TEXT').run(); } catch (e) { /* đã có cột */ }
    try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN loai_doi_tac TEXT').run(); } catch (e) { /* đã có cột */ }

  db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_doan_ra (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_by_email TEXT NOT NULL,
    submitted_by_name TEXT,
    muc_dich TEXT,
    quoc_gia TEXT NOT NULL,
    ngay_di TEXT NOT NULL,
    ngay_ve TEXT NOT NULL,
    thanh_vien TEXT,
    nguon_kinh_phi TEXT,
    du_toan TEXT,
    status TEXT NOT NULL DEFAULT 'cho_phong_duyet',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

  db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_doan_vao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_by_email TEXT NOT NULL,
    submitted_by_name TEXT,
    muc_dich TEXT,
    don_vi_de_xuat TEXT,
    ngay_den TEXT NOT NULL,
    ngay_roi_di TEXT,
    thanh_phan_doan TEXT,
    noi_dung_lam_viec TEXT,
    kinh_phi_nguon TEXT,
    ho_tro_visa TEXT,
    status TEXT NOT NULL DEFAULT 'cho_tham_dinh',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

  db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_thoa_thuan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ten TEXT NOT NULL,
    doi_tac TEXT NOT NULL,
    loai TEXT NOT NULL,
    het_han TEXT,
    trang_thai TEXT NOT NULL DEFAULT 'hieu_luc',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

  db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);
  try {
    db.prepare('INSERT OR IGNORE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_expiry_alert_months', '3');
  } catch (e) { /* ignore */ }
  try {
    db.prepare('INSERT OR IGNORE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_post_expiry_max_emails', '3');
  } catch (e) { /* ignore */ }
  try {
    db.prepare('INSERT OR IGNORE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_post_expiry_min_days', '7');
  } catch (e) { /* ignore */ }
  try {
    db.prepare('INSERT OR IGNORE INTO cooperation_settings (key, value) VALUES (?, ?)').run('cap_vien_step7_complete_send_email', '1');
  } catch (e) { /* ignore */ }
  try {
    db.prepare('INSERT OR IGNORE INTO cooperation_settings (key, value) VALUES (?, ?)').run('chairman_email_controls', '{}');
  } catch (e) { /* ignore */ }
  try {
    db.prepare('INSERT OR IGNORE INTO cooperation_settings (key, value) VALUES (?, ?)').run('council_member_email_controls', '{}');
  } catch (e) { /* ignore */ }
  try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN expiry_alert_sent_at TEXT').run(); } catch (e) { /* đã có cột */ }
  try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN post_expiry_alert_count INTEGER DEFAULT 0').run(); } catch (e) { /* đã có cột */ }
  try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN last_post_expiry_alert_at TEXT').run(); } catch (e) { /* đã có cột */ }
  try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN scan_file_path TEXT').run(); } catch (e) { /* đã có cột */ }
  try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN scan_file_name TEXT').run(); } catch (e) { /* đã có cột */ }
  try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN scan_uploaded_at TEXT').run(); } catch (e) { /* đã có cột */ }

  db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    so_van_ban TEXT,
    tieu_de TEXT NOT NULL,
    loai TEXT,
    don_vi_to_chuc TEXT,
    hinh_thuc TEXT,
    link_su_kien TEXT,
    dia_diem TEXT,
    quy_mo INTEGER,
    lich_trinh TEXT,
    muc_tieu TEXT,
    thanh_phan_tham_du TEXT,
    kinh_phi_du_kien REAL,
    nguon_kinh_phi TEXT,
    ngay_bat_dau TEXT,
    ngay_ket_thuc TEXT,
    han_dang_ky TEXT,
    ngay_tao TEXT DEFAULT (datetime('now','localtime')),
    nguoi_tao TEXT,
    trang_thai TEXT DEFAULT 'draft',
    so_nguoi_tham_du_thuc_te INTEGER,
    ket_qua_su_kien TEXT,
    de_xuat_kien_nghi TEXT,
    bai_hoc_kinh_nghiem TEXT,
    uu_diem TEXT,
    han_che TEXT,
    nguoi_phu_trach TEXT,
    phu_trach_lien_he TEXT,
    ghi_chu TEXT,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS event_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    loai_file TEXT NOT NULL,
    ten_file TEXT NOT NULL,
    duong_dan TEXT NOT NULL,
    mo_ta TEXT,
    nguoi_upload TEXT,
    ngay_upload TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (event_id) REFERENCES events(id)
  );
  CREATE TABLE IF NOT EXISTS event_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    ngay TEXT,
    gio_bat_dau TEXT,
    gio_ket_thuc TEXT,
    noi_dung TEXT,
    thu_tu INTEGER,
    FOREIGN KEY (event_id) REFERENCES events(id)
  );
  CREATE TABLE IF NOT EXISTS event_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    note TEXT,
    changed_by_id INTEGER,
    changed_by_name TEXT,
    changed_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (event_id) REFERENCES events(id)
  );
`);

  db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_mou_de_xuat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_by_email TEXT NOT NULL,
    submitted_by_name TEXT,
    loai_thoa_thuan TEXT,
    ten_doi_tac TEXT,
    quoc_gia TEXT,
    thoi_han_nam TEXT,
    gia_tri_tai_chinh TEXT,
    don_vi_de_xuat TEXT,
    noi_dung_hop_tac TEXT,
    status TEXT NOT NULL DEFAULT 'dang_tham_dinh',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

  // Đề xuất tiếp nhận tài chính YTNN (Chương VII Quy chế KHCN-ĐMST SCI 2026)
  db.exec(`
  CREATE TABLE IF NOT EXISTS htqt_de_xuat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ma_de_xuat TEXT,
    ten TEXT NOT NULL,
    mo_ta TEXT,
    doi_tac_ten TEXT,
    doi_tac_quoc_gia TEXT,
    doi_tac_nguoi_dai_dien TEXT,
    doi_tac_website TEXT,
    hinh_thuc_hop_tac TEXT,
    chu_nhiem_ten TEXT,
    chu_nhiem_hoc_vi TEXT,
    chu_nhiem_don_vi TEXT,
    thanh_vien_json TEXT,
    ngay_bat_dau TEXT,
    ngay_ket_thuc TEXT,
    thoi_gian_thang INTEGER,
    kinh_phi REAL,
    don_vi_tien_te TEXT DEFAULT 'VNĐ',
    kinh_phi_vnd REAL,
    loai_hinh TEXT,
    to_phan_loai_json TEXT,
    to_trinh_phong_khcn TEXT,
    de_nghi_vt TEXT,
    vt_y_kien TEXT,
    vt_ngay_ky TEXT,
    vt_so_van_ban TEXT,
    vt_nguoi_ky_id INTEGER,
    ly_do_khong_duyet TEXT,
    han_xu_ly_vt TEXT,
    muc_do_uu_tien TEXT DEFAULT 'binh_thuong',
    ghi_chu_noi_bo TEXT,
    nguoi_phu_trach_id INTEGER,
    phi_quan_ly_pct REAL,
    phi_quan_ly_vnd REAL,
    submitted_by_email TEXT,
    submitted_by_name TEXT,
    submitted_by_id INTEGER,
    status TEXT NOT NULL DEFAULT 'cho_phan_loai',
    ngay_tiep_nhan TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS htqt_de_xuat_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    de_xuat_id INTEGER NOT NULL,
    loai_file TEXT,
    ten_file TEXT,
    duong_dan TEXT,
    uploaded_by_id INTEGER,
    uploaded_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (de_xuat_id) REFERENCES htqt_de_xuat(id)
  )
`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS htqt_de_xuat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    de_xuat_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    performed_by_id INTEGER,
    performed_by_name TEXT,
    performed_at TEXT DEFAULT (datetime('now')),
    note TEXT,
    metadata TEXT,
    FOREIGN KEY (de_xuat_id) REFERENCES htqt_de_xuat(id)
  )
`);
};
