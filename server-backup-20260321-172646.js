/**
 * Backend SCI-ACE
 * - Đăng ký (chỉ @sci.edu.vn), đăng nhập
 * - Nộp hồ sơ (upload), gửi email thông báo Hội đồng
 * - Hội đồng xem/tải hồ sơ
 * - Admin (sinhnguyen@sci.edu.vn) cấp quyền: Chủ tịch, Thư ký, Thành viên Hội đồng
 */
try { require('dotenv').config({ path: '.env' }); } catch (_) {}
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// Route kiểm tra sớm nhất (trước middleware)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend đang chạy' });
});

// Favicon: trả 204 để tránh 404 trong Console khi trình duyệt tự gọi /favicon.ico
app.get('/favicon.ico', (req, res) => {
  const favPath = path.join(__dirname, 'favicon.ico');
  if (fs.existsSync(favPath)) return res.sendFile(favPath);
  res.status(204).end();
});

// Route phục vụ logo (đường dẫn tuyệt đối, tránh lỗi khi mở qua server)
const logoPath = path.join(__dirname, 'images', 'logo-vien-te-bao-goc.png');
app.get('/images/logo-vien-te-bao-goc.png', (req, res) => {
  if (fs.existsSync(logoPath)) {
    res.sendFile(logoPath);
  } else {
    res.status(404).send('Logo not found');
  }
});

const JWT_SECRET = process.env.JWT_SECRET || 'sci-ace-secret-change-in-production';
const ALLOWED_EMAIL_DOMAIN = '@sci.edu.vn';
const ADMIN_EMAIL = 'ntsinh0409@gmail.com'; // Admin mặc định khi khởi tạo; Admin có thể thêm Admin khác

// Database
const dbPath = path.join(__dirname, 'data', 'sci-ace.db');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'uploads-cap-vien'), { recursive: true });

const db = new Database(dbPath);

// DB riêng cho Đề tài cấp Viện (Nhiệm vụ KHCN cấp cơ sở)
const capVienDbPath = path.join(__dirname, 'data', 'de-tai-cap-vien.db');
const dbCapVien = new Database(capVienDbPath);
dbCapVien.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    submittedBy TEXT NOT NULL,
    submittedById INTEGER NOT NULL,
    status TEXT DEFAULT 'SUBMITTED',
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS cap_vien_submission_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    fieldName TEXT NOT NULL,
    originalName TEXT NOT NULL,
    path TEXT NOT NULL,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
`);
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewNote TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewedAt TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewedById INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN revisionRound INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
dbCapVien.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_step2_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    actionType TEXT NOT NULL,
    performedAt TEXT NOT NULL,
    performedById INTEGER,
    performedByName TEXT,
    performedByRole TEXT,
    note TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  )
`);
dbCapVien.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_submission_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    stepId TEXT NOT NULL,
    actionType TEXT NOT NULL,
    performedAt TEXT NOT NULL,
    performedById INTEGER,
    performedByName TEXT,
    performedByRole TEXT,
    note TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  )
`);
try { db.prepare('ALTER TABLE users ADD COLUMN academicTitle TEXT').run(); } catch (e) { /* đã tồn tại */ }

function insertCapVienStep2History(submissionId, actionType, performedById, performedByRole, note) {
  const performedAt = new Date().toISOString();
  const u = performedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(performedById) : null;
  const performedByName = u ? (u.fullname || u.email || '') : '';
  dbCapVien.prepare(
    'INSERT INTO cap_vien_step2_history (submissionId, actionType, performedAt, performedById, performedByName, performedByRole, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(submissionId, actionType, performedAt, performedById || null, performedByName, performedByRole || null, note || null);
  insertCapVienHistory(submissionId, '2', actionType, performedById, performedByRole, note);
}

function insertCapVienHistory(submissionId, stepId, actionType, performedById, performedByRole, note, performedAtOverride) {
  const performedAt = performedAtOverride || new Date().toISOString();
  const u = performedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(performedById) : null;
  const performedByName = u ? (u.fullname || u.email || '') : '';
  dbCapVien.prepare(
    'INSERT INTO cap_vien_submission_history (submissionId, stepId, actionType, performedAt, performedById, performedByName, performedByRole, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(submissionId, stepId, actionType, performedAt, performedById || null, performedByName, performedByRole || null, note || null);
}

// Backfill lịch sử cho hồ sơ đã xử lý trước khi có bảng history
(function backfillCapVienHistory() {
  const allSubs = dbCapVien.prepare('SELECT id, status, createdAt, submittedById, reviewedAt, reviewedById, reviewNote, assignedAt, assignedById, assignedReviewerIds FROM cap_vien_submissions').all();
  for (const sub of allSubs) {
    const hasStep1 = dbCapVien.prepare('SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = ? LIMIT 1').get(sub.id, '1');
    if (!hasStep1 && sub.createdAt && sub.submittedById) {
      insertCapVienHistory(sub.id, '1', 'researcher_submit', sub.submittedById, 'researcher', 'Nghiên cứu viên nộp hồ sơ đề xuất', sub.createdAt);
    }
    const hasStep2 = dbCapVien.prepare('SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = ? LIMIT 1').get(sub.id, '2');
    if (!hasStep2 && sub.reviewedAt && sub.reviewedById) {
      const u = db.prepare('SELECT fullname, role FROM users WHERE id = ?').get(sub.reviewedById);
      const performedByName = u ? (u.fullname || '') : '';
      const role = (u && u.role === 'admin') ? 'admin' : 'secretary';
      const actionType = (sub.status || '').toUpperCase() === 'VALIDATED' ? 'secretary_approve' : 'secretary_request_revision';
      const note = sub.reviewNote || (actionType === 'secretary_approve' ? 'Hợp lệ' : null);
      insertCapVienHistory(sub.id, '2', actionType, sub.reviewedById, role, note, sub.reviewedAt);
      const existingStep2 = dbCapVien.prepare('SELECT 1 FROM cap_vien_step2_history WHERE submissionId = ? LIMIT 1').get(sub.id);
      if (!existingStep2) {
        dbCapVien.prepare(
          'INSERT INTO cap_vien_step2_history (submissionId, actionType, performedAt, performedById, performedByName, performedByRole, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(sub.id, actionType, sub.reviewedAt, sub.reviewedById, performedByName, role, note);
      }
    }
    const hasStep3 = dbCapVien.prepare('SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = ? LIMIT 1').get(sub.id, '3');
    if (!hasStep3 && sub.assignedAt && sub.assignedById) {
      const reviewerIds = (() => { try { return JSON.parse(sub.assignedReviewerIds || '[]'); } catch(e) { return []; } })();
      const names = reviewerIds.length ? db.prepare('SELECT fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds).map(r => r.fullname || '') : [];
      insertCapVienHistory(sub.id, '3', 'chairman_assign', sub.assignedById, 'chairman', 'Phân công 2 phản biện: ' + names.join(', '), sub.assignedAt);
    }
  }
})();
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedReviewerIds TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedAt TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedById INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_status TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_note TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_requested_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_requested_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_approved_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_approved_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step_4_reviewer1_done INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step_4_reviewer2_done INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN code TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { dbCapVien.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN options_checked TEXT').run(); } catch (e) { /* đã tồn tại */ }
dbCapVien.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_submission_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    affects_code INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  )
`);
(function seedCapVienOptions() {
  const opts = dbCapVien.prepare('SELECT id FROM cap_vien_submission_options LIMIT 1').get();
  if (opts) return;
  dbCapVien.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run('coe', 'CoE', 1, 1);
  dbCapVien.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run('kinh_phi_vien', 'Kinh phí từ Viện Tế bào gốc', 0, 2);
})();

// Bảng danh mục hạng mục đề tài cấp Viện (admin quản trị)
dbCapVien.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_linh_vuc (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cap_vien_loai_de_tai (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cap_vien_don_vi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cap_vien_khoan_muc_chi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    parent_code TEXT,
    sort_order INTEGER DEFAULT 0
  )
`);
(function seedCapVienCategories() {
  const hasLv = dbCapVien.prepare('SELECT id FROM cap_vien_linh_vuc LIMIT 1').get();
  if (!hasLv) {
    const lv = [['stem-cell', 'Tế bào gốc', 1], ['biotechnology', 'Công nghệ sinh học', 2], ['medicine', 'Y sinh học', 3], ['other', 'Khác', 4]];
    lv.forEach(([c, l, o]) => dbCapVien.prepare('INSERT INTO cap_vien_linh_vuc (code, label, sort_order) VALUES (?, ?, ?)').run(c, l, o));
  }
  const hasLdt = dbCapVien.prepare('SELECT id FROM cap_vien_loai_de_tai LIMIT 1').get();
  if (!hasLdt) {
    const ldt = [['research', 'Đề tài nghiên cứu', 1], ['project', 'Dự án', 2], ['program', 'Chương trình', 3]];
    ldt.forEach(([c, l, o]) => dbCapVien.prepare('INSERT INTO cap_vien_loai_de_tai (code, label, sort_order) VALUES (?, ?, ?)').run(c, l, o));
  }
  const hasKm = dbCapVien.prepare('SELECT id FROM cap_vien_khoan_muc_chi LIMIT 1').get();
  if (!hasKm) {
    const km = [
      ['1', 'Chi thù lao cho cán bộ khoa học', null, 1],
      ['1.1', 'Chủ nhiệm đề tài', '1', 2],
      ['1.2', 'Thành viên chính', '1', 3],
      ['1.3', 'Kỹ thuật viên/Trợ lý', '1', 4],
      ['2', 'Chi mua vật tư, nguyên liệu', null, 5],
      ['2.1', 'Hóa chất', '2', 6],
      ['2.2', 'Sinh phẩm', '2', 7],
      ['2.3', 'Dụng cụ thí nghiệm tiêu hao', '2', 8],
      ['3', 'Chi mua sắm, sửa chữa tài sản cố định', null, 9],
      ['3.1', 'Thiết bị', '3', 10],
      ['3.2', 'Phần mềm', '3', 11],
      ['4', 'Chi hội nghị, hội thảo, công tác phí', null, 12],
      ['4.1', 'Hội nghị, hội thảo khoa học', '4', 13],
      ['4.2', 'Công tác phí trong nước', '4', 14],
      ['4.3', 'Công tác phí nước ngoài', '4', 15],
      ['5', 'Chi thuê ngoài', null, 16],
      ['5.1', 'Thuê chuyên gia', '5', 17],
      ['5.2', 'Thuê dịch vụ phân tích', '5', 18],
      ['6', 'Chi khác', null, 19],
      ['6.1', 'Chi phí quản lý chung (tối đa 5%)', '6', 20],
      ['6.2', 'Chi phí in ấn, văn phòng phẩm', '6', 21]
    ];
    km.forEach(([c, l, p, o]) => dbCapVien.prepare('INSERT INTO cap_vien_khoan_muc_chi (code, label, parent_code, sort_order) VALUES (?, ?, ?, ?)').run(c, l, p, o));
  }
})();
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

// Bảng placeholder cho thống kê trang chủ (khi có module tương ứng sẽ thêm cột và dữ liệu)
db.exec(`CREATE TABLE IF NOT EXISTS personnel (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
db.exec(`CREATE TABLE IF NOT EXISTS ip_assets (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
db.exec(`CREATE TABLE IF NOT EXISTS publications (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
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
    status TEXT NOT NULL DEFAULT 'cho_ky_duyet',
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

function syncMissionsFromCapVien() {
  const rows = dbCapVien.prepare('SELECT id, title, submittedById, status, createdAt, code FROM cap_vien_submissions').all();
  const hidden = new Set(
    db.prepare("SELECT source_type || ':' || source_id AS k FROM missions_hidden").all().map(r => r.k)
  );
  const statusMap = {
    SUBMITTED: 'planning',
    NEED_REVISION: 'planning',
    VALIDATED: 'approved',
    REVIEWED: 'ongoing',
    IN_MEETING: 'ongoing',
    APPROVED: 'ongoing',
    IMPLEMENTATION: 'ongoing',
    COMPLETED: 'completed',
    REJECTED: 'planning'
  };
  const now = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    if (hidden.has('cap_vien:' + r.id)) continue;
    const code = r.code || ('DTSCI-' + (r.createdAt || '').slice(0, 4) + '-' + String(r.id).padStart(3, '0'));
    const principal = (r.submittedById ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(r.submittedById) : null);
    const principalName = principal ? (principal.fullname || '') : '';
    const status = statusMap[(r.status || '').toUpperCase()] || 'planning';
    let startDate = (r.createdAt || '').toString().slice(0, 10);
    if (!startDate) startDate = now;
    const end = new Date(startDate);
    end.setFullYear(end.getFullYear() + 2);
    const endDate = end.toISOString().slice(0, 10);
    const progress = status === 'completed' ? 100 : (status === 'planning' ? 5 : 35);
    const existing = db.prepare('SELECT id FROM missions WHERE source_type = ? AND source_id = ?').get('cap_vien', r.id);
    if (existing) {
      db.prepare(
        `UPDATE missions SET code=?, title=?, principal=?, status=?, start_date=?, end_date=?, progress=? WHERE source_type='cap_vien' AND source_id=?`
      ).run(code, r.title || '', principalName, status, startDate, endDate, progress, r.id);
    } else {
      db.prepare(
        `INSERT INTO missions (code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type) VALUES (?, ?, ?, 'institute', ?, ?, ?, ?, NULL, ?, 'cap_vien')`
      ).run(code, r.title || '', principalName, status, startDate, endDate, progress, r.id);
    }
  }
}

function insertGd5History(submissionId, actionType, performedById, fileFieldName, originalFileName, label) {
  const performedAt = new Date().toISOString();
  const u = performedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(performedById) : null;
  const performedByName = u ? (u.fullname || u.email || '') : '';
  db.prepare(
    'INSERT INTO submission_gd5_history (submissionId, actionType, performedAt, performedById, performedByName, fileFieldName, originalFileName, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(submissionId, actionType, performedAt, performedById || null, performedByName, fileFieldName || null, originalFileName || null, label || null);
}

// Sửa tên file bị bể dấu: trình duyệt gửi UTF-8 nhưng Node đọc header theo Latin-1 → chuyển lại UTF-8
function fixFilenameEncoding(name) {
  if (!name || typeof name !== 'string') return name || '';
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch (e) {
    return name;
  }
}

// Tên thư mục an toàn từ họ tên (loại bỏ ký tự đặc biệt, khoảng trắng → gạch dưới)
function sanitizeFolderName(name) {
  if (!name || typeof name !== 'string') return 'Nghien_cuu_vien';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'Nghien_cuu_vien';
}

// Multer: lưu file tạm, sau khi tạo submission sẽ chuyển vào uploads/<Họ tên NCV>/submission_<id>/
const uploadDir = path.join(__dirname, 'uploads');
const tempUploadDir = path.join(uploadDir, 'temp');
fs.mkdirSync(tempUploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!req._uploadDir) {
      req._uploadDir = path.join(tempUploadDir, 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2));
      fs.mkdirSync(req._uploadDir, { recursive: true });
    }
    cb(null, req._uploadDir);
  },
  filename: function (req, file, cb) {
    const safe = (file.originalname || file.fieldname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }
});

// Multer cho Đề tài cấp Viện (thư mục riêng)
const uploadDirCapVien = path.join(__dirname, 'uploads-cap-vien');
const tempUploadDirCapVien = path.join(uploadDirCapVien, 'temp');
fs.mkdirSync(tempUploadDirCapVien, { recursive: true });
const storageCapVien = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!req._uploadDirCapVien) {
      req._uploadDirCapVien = path.join(tempUploadDirCapVien, 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2));
      fs.mkdirSync(req._uploadDirCapVien, { recursive: true });
    }
    cb(null, req._uploadDirCapVien);
  },
  filename: function (req, file, cb) {
    const safe = (file.originalname || file.fieldname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const uploadCapVien = multer({
  storage: storageCapVien,
  limits: { fileSize: 20 * 1024 * 1024 }
});

// Cấu hình mặc định cho các module trên trang chủ
const HOMEPAGE_MODULES_DEFAULT = [
  { code: 'missions', label: 'Quản lý nhiệm vụ KHCN', enabled: 1 },
  { code: 'ethics_ace', label: 'Hội đồng đạo đức trên động vật (SCI-ACE)', enabled: 1 },
  { code: 'personnel', label: 'Quản lý Nhân lực KHCN', enabled: 0 },
  { code: 'ip', label: 'Quản lý Tài sản Trí tuệ', enabled: 0 },
  { code: 'finance', label: 'Quản lý Tài chính KHCN', enabled: 0 },
  { code: 'publications', label: 'Quản lý Công bố Khoa học', enabled: 0 },
  { code: 'cooperation', label: 'Quản lý Hợp tác', enabled: 1 },
  { code: 'tech_transfer', label: 'Quản lý Chuyển giao Công nghệ', enabled: 0 },
  { code: 'facilities', label: 'Quản lý Cơ sở vật chất', enabled: 1 },
  { code: 'ethics_integrity', label: 'Đạo đức và Liêm chính khoa học', enabled: 0 },
  { code: 'reward', label: 'Quản lý Khen thưởng & Đánh giá', enabled: 0 }
];

// Email (cấu hình qua biến môi trường)
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function getCouncilEmails() {
  const stmt = db.prepare("SELECT email FROM users WHERE role IN ('chu_tich','thu_ky','thanh_vien','admin')");
  return stmt.all().map(r => r.email);
}

function getBudgetTeamEmails() {
  const stmt = db.prepare("SELECT email FROM users WHERE role IN ('totruong_tham_dinh_tc','thanh_vien_tham_dinh_tc')");
  return stmt.all().map(r => r.email).filter(Boolean);
}

function getChairmanEmail() {
  const row = db.prepare("SELECT email FROM users WHERE role = 'chu_tich' LIMIT 1").get();
  return row ? row.email : null;
}

function computeNhanhFromLevel(level) {
  const lev = (level || '').toLowerCase();
  if (['ministry', 'university'].includes(lev)) return 'A';
  if (['national'].includes(lev)) return 'B';
  return 'B';
}

// Danh sách email nhận thông báo: ưu tiên bảng notification_recipients (Admin quản lý), không có thì NOTIFICATION_EMAILS, rồi Hội đồng trong DB
function getNotificationEmails() {
  try {
    const rows = db.prepare('SELECT email FROM notification_recipients ORDER BY id').all();
    if (rows && rows.length > 0) {
      return rows.map(r => (r.email || '').trim().toLowerCase()).filter(Boolean);
    }
  } catch (e) { /* bảng chưa có */ }
  const envList = (process.env.NOTIFICATION_EMAILS || '').trim();
  if (envList) {
    return envList.split(/[,;]/).map(e => e.trim().toLowerCase()).filter(Boolean);
  }
  return getCouncilEmails();
}

// Module Hợp tác quốc tế: lấy email nhận thông báo theo topic (doan_ra, mou, ...) hoặc 'all'
function getCooperationRecipients(topic) {
  try {
    const rows = db.prepare('SELECT email, topics FROM cooperation_notification_recipients').all();
    const list = [];
    for (const r of rows || []) {
      const em = (r.email || '').trim().toLowerCase();
      if (!em) continue;
      const t = (r.topics || 'all').trim().toLowerCase();
      if (t === 'all' || t.split(',').map(s => s.trim()).includes(topic)) list.push(em);
    }
    return list;
  } catch (e) { return []; }
}

// Trả về { to: [email Viện trưởng], cc: [các email khác] } — dùng cho email MOU (Kính gửi Viện trưởng, CC những người còn lại)
function getCooperationRecipientsSplit(topic) {
  try {
    const rows = db.prepare('SELECT email, topics, role FROM cooperation_notification_recipients').all();
    const toList = [];
    const ccList = [];
    for (const r of rows || []) {
      const em = (r.email || '').trim().toLowerCase();
      if (!em) continue;
      const t = (r.topics || 'all').trim().toLowerCase();
      if (t !== 'all' && !t.split(',').map(s => s.trim()).includes(topic)) continue;
      if ((r.role || '').toString().toLowerCase() === 'vien_truong') toList.push(em);
      else ccList.push(em);
    }
    if (toList.length === 0 && ccList.length > 0) {
      toList.push(ccList.shift());
    }
    return { to: toList, cc: ccList };
  } catch (e) { return { to: [], cc: [] }; }
}

function sendNotificationToCouncil(submissionTitle, submittedByEmail) {
  const toList = getNotificationEmails();
  if (!transporter || toList.length === 0) {
    if (!transporter) console.log('[Email] Bỏ qua: chưa cấu hình SMTP (kiểm tra file .env có SMTP_HOST, SMTP_USER)');
    else console.log('[Email] Bỏ qua: chưa có người nhận (thêm trong Quản trị → Danh sách người nhận email)');
    return Promise.resolve();
  }
  console.log('[Email] Gửi thông báo hồ sơ mới tới: ' + toList.join(', '));
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toList.join(', '),
    subject: '[SCI-ACE] Hồ sơ mới được nộp: ' + submissionTitle,
    text: 'Nghiên cứu viên ' + submittedByEmail + ' vừa nộp hồ sơ: ' + submissionTitle + '. Vui lòng đăng nhập vào khu vực Hội đồng để xem và tải hồ sơ.',
    html: '<p>Nghiên cứu viên <strong>' + submittedByEmail + '</strong> vừa nộp hồ sơ: <strong>' + submissionTitle + '</strong>.</p><p>Vui lòng đăng nhập vào <a href="' + (process.env.BASE_URL || 'http://localhost:' + PORT) + '/hoi-dong.html">khu vực Hội đồng</a> để xem và tải hồ sơ.</p>'
  }).catch(err => console.error('[Email] Lỗi gửi:', err.message));
}

// Helper: thông tin bước hiện tại / sắp tới / người duyệt theo status (Đề tài cấp Viện)
function getCapVienStepInfo(status) {
  const s = (status || 'SUBMITTED').toUpperCase();
  const map = {
    SUBMITTED: { current: 'Bước 1: Nộp hồ sơ đề xuất (đã hoàn thành)', next: 'Bước 2: Kiểm tra hồ sơ hành chính', who: 'Thư ký HĐKHCN' },
    NEED_REVISION: { current: 'Bước 2: Kiểm tra hồ sơ hành chính (đang chờ hồ sơ bổ sung)', next: 'Bước 2: Kiểm tra hồ sơ hành chính', who: 'Thư ký HĐKHCN' },
    VALIDATED: { current: 'Bước 2: Kiểm tra hồ sơ hành chính (đã hoàn thành)', next: 'Bước 3: Phân công phản biện', who: 'Chủ tịch HĐKHCN' },
    ASSIGNED: { current: 'Bước 3: Phân công phản biện (đã hoàn thành)', next: 'Bước 4: Đánh giá phản biện', who: '2 Phản biện' },
    UNDER_REVIEW: { current: 'Bước 4: Đánh giá phản biện (đang thực hiện)', next: 'Bước 4: Đánh giá phản biện', who: '2 Phản biện' },
    REVIEWED: { current: 'Bước 4: Đánh giá phản biện (đã hoàn thành)', next: 'Bước 5: Họp Hội đồng Khoa học Viện', who: 'HĐKHCN' },
    IN_MEETING: { current: 'Bước 5: Họp Hội đồng (đang thực hiện)', next: 'Bước 5: Họp Hội đồng', who: 'HĐKHCN' },
    CONDITIONAL: { current: 'Bước 5: Họp Hội đồng (đã họp)', next: 'Bước 6: Cấp Quyết định phê duyệt', who: 'Viện trưởng' },
    APPROVED: { current: 'Bước 6: Cấp Quyết định phê duyệt (đã hoàn thành)', next: 'Bước 7: Ký hợp đồng thực hiện', who: 'Viện trưởng & Chủ nhiệm' },
    CONTRACTED: { current: 'Bước 7: Ký hợp đồng (đã hoàn thành)', next: 'Bước tiếp theo theo quy định', who: '—' },
    IMPLEMENTATION: { current: 'Đang thực hiện đề tài', next: 'Báo cáo tiến độ / Nghiệm thu', who: '—' },
    COMPLETED: { current: 'Đã hoàn thành', next: '—', who: '—' },
    REJECTED: { current: 'Đã dừng/từ chối', next: '—', who: '—' }
  };
  return map[s] || map.SUBMITTED;
}

// Đề tài cấp Viện: gửi thông báo khi có hồ sơ mới nộp
function sendCapVienNewSubmissionEmail(opts) {
  const { submissionId, submissionTitle, submittedByEmail, submittedByName, createdAt, status } = opts;
  const toList = getNotificationEmails();
  if (!transporter || toList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
  const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'Nghiên cứu viên');
  const stepInfo = getCapVienStepInfo(status || 'SUBMITTED');
  const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : '—';

  const subject = '[Đề tài cấp Viện Tế bào gốc]: Hồ sơ mới được nộp: ' + (submissionTitle || '');
  const text =
    'Kính gửi Quý thành viên Hội đồng,\n\n' +
    'Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc có ghi nhận hồ sơ mới đăng kí đề tài cấp Viện TBG do ' + submitterLabel + ' nộp.\n\n' +
    'Thông tin đề tài:\n- Tên đề tài: ' + (submissionTitle || '') + '\n- Người nộp: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- Ngày nộp: ' + dateStr + '\n\n' +
    'Khu vực Hội đồng (theo dõi và tải hồ sơ): ' + councilUrl + '\n\n' +
    'Hiện tại: ' + stepInfo.current + '\n' +
    'Sắp tới: ' + stepInfo.next + '\n' +
    'Chờ duyệt bởi: ' + stepInfo.who + '\n\n' +
    'Trân trọng.';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>Kính gửi Quý thành viên Hội đồng,</p>' +
    '<p>Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc có ghi nhận hồ sơ mới đăng kí đề tài cấp Viện TBG do <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> nộp.</p>' +
    '<p><strong>Thông tin đề tài:</strong></p>' +
    '<ul style="margin:0.5em 0">' +
    '<li>Tên đề tài: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong></li>' +
    '<li>Người nộp: ' + (String(submitterLabel).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(submittedByEmail || '').replace(/</g, '&lt;')) + ')</li>' +
    '<li>Ngày nộp: ' + (String(dateStr).replace(/</g, '&lt;')) + '</li>' +
    '</ul>' +
    '<p>Khu vực Hội đồng để theo dõi và tải hồ sơ:</p>' +
    '<p><a href="' + councilUrl + '" style="color:#1565c0">' + councilUrl + '</a></p>' +
    '<p><strong>Hiện tại:</strong> ' + (stepInfo.current.replace(/</g, '&lt;')) + '<br>' +
    '<strong>Sắp tới:</strong> ' + (stepInfo.next.replace(/</g, '&lt;')) + '<br>' +
    '<strong>Chờ duyệt bởi:</strong> ' + (stepInfo.who.replace(/</g, '&lt;')) + '</p>' +
    '<p>Trân trọng.</p>' +
    '</div>';

  console.log('[Email] Gửi thông báo Đề tài cấp Viện (hồ sơ mới) tới: ' + toList.join(', '));
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toList.join(', '),
    subject,
    text,
    html
  }).catch(err => console.error('[Email] Lỗi gửi (Đề tài cấp Viện):', err.message));
}

// Đề tài cấp Viện — Bước 2: Yêu cầu bổ sung — gửi nghiên cứu viên (chính) + thông báo Hội đồng (phụ)
function sendCapVienStep2RevisionEmail(submissionTitle, researcherEmail, note, secretaryName, submissionId, researcherName) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const resubmitUrl = baseUrl + '/nop-de-tai-cap-vien.html?resubmit=' + (submissionId || '');
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
  const researcherLabel = (researcherName && researcherName.trim()) ? researcherName.trim() : (researcherEmail || 'Nghiên cứu viên');
  const secLabel = (secretaryName && secretaryName.trim()) ? secretaryName.trim() : 'Thư ký HĐKHCN';
  const noteEsc = String(note || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const noteBlock = note ? '<p><strong>Nội dung yêu cầu bổ sung:</strong></p><p style="white-space:pre-wrap;background:#fff8e1;padding:12px;border-radius:8px">' + noteEsc + '</p>' : '';

  const promises = [];
  if (!transporter) return Promise.all(promises);

  // Email chính: nghiên cứu viên — yêu cầu bổ sung hồ sơ
  if (researcherEmail) {
    const subjectRes = '[Đề tài cấp Viện Tế bào gốc]: Yêu cầu bổ sung hồ sơ (Bước 2): ' + (submissionTitle || '');
    const textRes =
      'Kính gửi ' + researcherLabel + ',\n\n' +
      'Thư ký HĐKHCN đã kiểm tra hồ sơ đề tài cấp Viện của bạn và yêu cầu bổ sung.\n\n' +
      'Nội dung yêu cầu bổ sung:\n' + (note || '') + '\n\n' +
      'Thông tin đề tài: ' + (submissionTitle || '') + '\n\n' +
      'Bạn cần chỉnh sửa và bổ sung hồ sơ theo nội dung trên, sau đó nộp lại hồ sơ qua hệ thống.\n\n' +
      'Nộp lại hồ sơ: ' + resubmitUrl + '\nTheo dõi đề tài: ' + timelineUrl + '\n\n' +
      'Trân trọng,\nHệ thống Quản lý Đề tài cấp Viện';
    const htmlRes =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi <strong>' + (researcherLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>,</p>' +
      '<p>Thư ký HĐKHCN đã kiểm tra hồ sơ đề tài cấp Viện của bạn và yêu cầu bổ sung.</p>' +
      noteBlock +
      '<p><strong>Thông tin đề tài:</strong> ' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' +
      '<p>Bạn cần chỉnh sửa và bổ sung hồ sơ theo nội dung trên, sau đó <strong>nộp lại hồ sơ</strong> qua hệ thống.</p>' +
      '<p><a href="' + resubmitUrl + '" style="color:#1565c0">Nộp lại hồ sơ</a> &nbsp;|&nbsp; <a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi đề tài</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    promises.push(transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: researcherEmail,
      subject: subjectRes,
      text: textRes,
      html: htmlRes
    }).catch(err => console.error('[Email] Lỗi gửi (Yêu cầu bổ sung → NCV):', err.message)));
  }

  // Email phụ: thành viên Hội đồng — thông báo để nắm thông tin
  const councilList = getNotificationEmails();
  if (councilList.length > 0) {
    const subjectCouncil = '[Đề tài cấp Viện Tế bào gốc] (Thông báo) Thư ký đã yêu cầu bổ sung hồ sơ: ' + (submissionTitle || '');
    const textCouncil =
      'Thông báo để các thành viên Hội đồng nắm thông tin:\n\n' +
      'Thư ký ' + secLabel + ' đã yêu cầu bổ sung hồ sơ cho đề tài «' + (submissionTitle || '') + '», do nghiên cứu viên ' + (researcherLabel + ' (' + (researcherEmail || '') + ')') + ' nộp.\n\n' +
      'Nội dung yêu cầu bổ sung:\n' + (note || '') + '\n\n' +
      'Theo dõi đề tài: ' + timelineUrl;
    const htmlCouncil =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p><strong>Thông báo để các thành viên Hội đồng nắm thông tin</strong></p>' +
      '<p>Thư ký <strong>' + (secLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> đã yêu cầu bổ sung hồ sơ cho đề tài <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>, do nghiên cứu viên ' + (researcherLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(researcherEmail || '').replace(/</g, '&lt;')) + ') nộp.</p>' +
      noteBlock +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi đề tài cấp Viện</a></p></div>';
    promises.push(transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: councilList.join(', '),
      subject: subjectCouncil,
      text: textCouncil,
      html: htmlCouncil
    }).catch(err => console.error('[Email] Lỗi gửi (Yêu cầu bổ sung → HĐ):', err.message)));
  }
  return Promise.all(promises);
}

// Đề tài cấp Viện — Bước 2 đã Hợp lệ: gửi thông báo (1) nghiên cứu viên, (2) thành viên Hội đồng
function sendCapVienStep2ValidatedEmail(opts) {
  const { submissionTitle, submittedByEmail, submittedByName, createdAt, status, reviewedByName, hasSupplement } = opts;
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
  const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'Nghiên cứu viên');
  const stepInfo = getCapVienStepInfo(status || 'VALIDATED');
  const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : '—';
  const reviewedLabel = (reviewedByName && reviewedByName.trim()) ? reviewedByName.trim() : 'Thư ký HĐKHCN';
  const supplementPhrase = hasSupplement ? ' sau khi nghiên cứu viên bổ sung hồ sơ' : '';

  const promises = [];

  // (1) Email chính: Nghiên cứu viên — thông báo hồ sơ đã hợp lệ, chuyển Bước 3
  if (submittedByEmail) {
    const subjectRes = hasSupplement
      ? '[Đề tài cấp Viện Tế bào gốc]: Hồ sơ bổ sung của bạn đã được kiểm tra hợp lệ (Bước 2): ' + (submissionTitle || '')
      : '[Đề tài cấp Viện Tế bào gốc]: Hồ sơ của bạn đã được kiểm tra hợp lệ (Bước 2): ' + (submissionTitle || '');
    const textRes =
      'Kính gửi ' + submitterLabel + ',\n\n' +
      'Thư ký HĐKHCN đã kiểm tra hồ sơ đề tài cấp Viện của bạn' + (hasSupplement ? ' (bao gồm hồ sơ bổ sung)' : '') + ' và đánh dấu Hợp lệ' + supplementPhrase + ' (Bước 2 – Kiểm tra hồ sơ hành chính).\n\n' +
      'Hồ sơ chuyển sang Bước 3 (Phân công phản biện).\n\n' +
      'Thông tin đề tài: ' + (submissionTitle || '') + '\nNgày nộp: ' + dateStr + '\n\n' +
      'Theo dõi đề tài: ' + timelineUrl + '\n\n' +
      'Trân trọng,\nHệ thống Quản lý Đề tài cấp Viện';
    const htmlRes =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>,</p>' +
      '<p>Thư ký HĐKHCN (' + (reviewedLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ') đã kiểm tra hồ sơ đề tài cấp Viện của bạn' + (hasSupplement ? ' (bao gồm hồ sơ bổ sung)' : '') + ' và đánh dấu <strong>Hợp lệ' + (supplementPhrase.replace(/</g, '&lt;')) + '</strong> (Bước 2 – Kiểm tra hồ sơ hành chính).</p>' +
      '<p>Hồ sơ chuyển sang <strong>Bước 3: Phân công phản biện</strong>.</p>' +
      '<p><strong>Thông tin đề tài:</strong> ' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '<br>Ngày nộp: ' + (String(dateStr).replace(/</g, '&lt;')) + '</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi đề tài cấp Viện</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    promises.push(transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: submittedByEmail,
      subject: subjectRes,
      text: textRes,
      html: htmlRes
    }).catch(err => console.error('[Email] Lỗi gửi (Bước 2 Hợp lệ → NCV):', err.message)));
  }

  // (2) Email phụ: Thành viên Hội đồng — thông báo để nắm thông tin
  const toList = getNotificationEmails();
  if (toList.length > 0) {
    const subjectCouncil = hasSupplement
      ? '[Đề tài cấp Viện Tế bào gốc]: Hồ sơ bổ sung đã được kiểm tra hợp lệ (Bước 2): ' + (submissionTitle || '')
      : '[Đề tài cấp Viện Tế bào gốc]: Hồ sơ đã được kiểm tra hợp lệ (Bước 2): ' + (submissionTitle || '');
    const textCouncil =
      'Kính gửi Quý thành viên Hội đồng,\n\n' +
      'Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc thông báo: hồ sơ đề tài cấp Viện TBG do ' + submitterLabel + ' nộp đã được ' + reviewedLabel + ' kiểm tra và đánh dấu Hợp lệ' + supplementPhrase + ' (Bước 2 – Kiểm tra hồ sơ hành chính).\n\n' +
      'Thông tin đề tài:\n- Tên đề tài: ' + (submissionTitle || '') + '\n- Người nộp: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- Ngày nộp: ' + dateStr + '\n\n' +
      'Khu vực Hội đồng (theo dõi và tải hồ sơ): ' + councilUrl + '\n\n' +
      'Hiện tại: ' + stepInfo.current + '\n' +
      'Sắp tới: ' + stepInfo.next + '\n' +
      'Chờ duyệt bởi: ' + stepInfo.who + '\n\n' +
      'Trân trọng.';
    const htmlCouncil =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi Quý thành viên Hội đồng,</p>' +
      '<p>Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc thông báo: hồ sơ đề tài cấp Viện TBG do <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> nộp đã được <strong>' + (reviewedLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> kiểm tra và đánh dấu <strong>Hợp lệ' + (supplementPhrase.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> (Bước 2 – Kiểm tra hồ sơ hành chính).</p>' +
      '<p><strong>Thông tin đề tài:</strong></p>' +
      '<ul style="margin:0.5em 0">' +
      '<li>Tên đề tài: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong></li>' +
      '<li>Người nộp: ' + (String(submitterLabel).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(submittedByEmail || '').replace(/</g, '&lt;')) + ')</li>' +
      '<li>Ngày nộp: ' + (String(dateStr).replace(/</g, '&lt;')) + '</li>' +
      '</ul>' +
      '<p>Khu vực Hội đồng để theo dõi và tải hồ sơ:</p>' +
      '<p><a href="' + councilUrl + '" style="color:#1565c0">' + councilUrl + '</a></p>' +
      '<p><strong>Hiện tại:</strong> ' + (stepInfo.current.replace(/</g, '&lt;')) + '<br>' +
      '<strong>Sắp tới:</strong> ' + (stepInfo.next.replace(/</g, '&lt;')) + '<br>' +
      '<strong>Chờ duyệt bởi:</strong> ' + (stepInfo.who.replace(/</g, '&lt;')) + '</p>' +
      '<p>Trân trọng.</p>' +
      '</div>';
    console.log('[Email] Gửi thông báo Đề tài cấp Viện (Bước 2 Hợp lệ) → NCV + HĐ: ' + (submittedByEmail || '') + ', ' + toList.join(', '));
    promises.push(transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: toList.join(', '),
      subject: subjectCouncil,
      text: textCouncil,
      html: htmlCouncil
    }).catch(err => console.error('[Email] Lỗi gửi (Bước 2 Hợp lệ → HĐ):', err.message)));
  }
  return Promise.all(promises);
}

// Đề tài cấp Viện — Nghiên cứu viên đã nộp hồ sơ bổ sung: gửi thông báo đến các thành viên Hội đồng
function sendCapVienSupplementSubmittedEmail(opts) {
  const { submissionTitle, submittedByEmail, submittedByName, createdAt, status, supplementRound } = opts;
  const toList = getNotificationEmails();
  if (!transporter || toList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'Nghiên cứu viên');
  const stepInfo = getCapVienStepInfo(status || 'SUBMITTED');
  const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : '—';
  const roundText = (supplementRound != null && supplementRound >= 1) ? ' (lần bổ sung thứ ' + supplementRound + ')' : '';

  const subject = '[Đề tài cấp Viện Tế bào gốc]: Nghiên cứu viên đã nộp hồ sơ bổ sung' + roundText + ': ' + (submissionTitle || '');
  const text =
    'Kính gửi Quý thành viên Hội đồng,\n\n' +
    'Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc thông báo: nghiên cứu viên ' + submitterLabel + ' đã nộp hồ sơ bổ sung cho đề tài cấp Viện TBG' + roundText + '.\n\n' +
    'Thông tin đề tài:\n- Tên đề tài: ' + (submissionTitle || '') + '\n- Người nộp: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- Ngày nộp hồ sơ gốc: ' + dateStr + '\n\n' +
    'Khu vực Hội đồng (theo dõi và tải hồ sơ): ' + councilUrl + '\n\n' +
    'Hiện tại: ' + stepInfo.current + '\n' +
    'Sắp tới: ' + stepInfo.next + '\n' +
    'Chờ duyệt bởi: ' + stepInfo.who + '\n\n' +
    'Trân trọng.';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>Kính gửi Quý thành viên Hội đồng,</p>' +
    '<p>Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc thông báo: nghiên cứu viên <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> đã nộp hồ sơ bổ sung cho đề tài cấp Viện TBG' + (roundText.replace(/</g, '&lt;')) + '.</p>' +
    '<p><strong>Thông tin đề tài:</strong></p>' +
    '<ul style="margin:0.5em 0">' +
    '<li>Tên đề tài: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong></li>' +
    '<li>Người nộp: ' + (String(submitterLabel).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(submittedByEmail || '').replace(/</g, '&lt;')) + ')</li>' +
    '<li>Ngày nộp hồ sơ gốc: ' + (String(dateStr).replace(/</g, '&lt;')) + '</li>' +
    '</ul>' +
    '<p>Khu vực Hội đồng để theo dõi và tải hồ sơ:</p>' +
    '<p><a href="' + councilUrl + '" style="color:#1565c0">' + councilUrl + '</a></p>' +
    '<p><strong>Hiện tại:</strong> ' + (stepInfo.current.replace(/</g, '&lt;')) + '<br>' +
    '<strong>Sắp tới:</strong> ' + (stepInfo.next.replace(/</g, '&lt;')) + '<br>' +
    '<strong>Chờ duyệt bởi:</strong> ' + (stepInfo.who.replace(/</g, '&lt;')) + '</p>' +
    '<p>Trân trọng.</p>' +
    '</div>';

  console.log('[Email] Gửi thông báo Đề tài cấp Viện (NCV đã nộp hồ sơ bổ sung) tới: ' + toList.join(', '));
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toList.join(', '),
    subject,
    text,
    html
  }).catch(err => console.error('[Email] Lỗi gửi (NCV nộp bổ sung):', err.message));
}

// Đề tài cấp Viện — Bước 3: Chủ tịch phân công phản biện — gửi đến từng phản biện + toàn Hội đồng
function sendCapVienStep3AssignEmail(submissionTitle, chairmanName, reviewerEmails, reviewerNames, submissionId) {
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const reviewersList = reviewerNames && reviewerNames.length ? reviewerNames.join(', ') : (reviewerEmails && reviewerEmails.length ? reviewerEmails.join(', ') : '');
  const htmlAll = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>Kính gửi Quý thành viên Hội đồng,</p>' +
    '<p>Chủ tịch HĐKHCN <strong>' + (chairmanName || 'Chủ tịch').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> đã phân công phản biện cho hồ sơ: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
    '<p><strong>Phản biện được phân công:</strong> ' + (String(reviewersList).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' +
    '<p>Giai đoạn đã chuyển sang <strong>Bước 4 – Đánh giá phản biện</strong>. Các thành viên được phân công cần hoàn thành phiếu đánh giá (SCI-TASK-06).</p>' +
    '<p><a href="' + councilUrl + '" style="color:#1565c0">Khu vực Hội đồng</a> | <a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình</a></p>' +
    '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
  const textAll = 'Chủ tịch đã phân công phản biện cho hồ sơ: ' + submissionTitle + '. Phản biện: ' + reviewersList + '. Giai đoạn chuyển sang Bước 4. ' + baseUrl;
  const promises = [];
  reviewerEmails.forEach((email, i) => {
    const name = reviewerNames && reviewerNames[i] ? reviewerNames[i] : '';
    const htmlYou = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi ' + (String(name || email).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ',</p>' +
      '<p>Chủ tịch HĐKHCN <strong>' + (chairmanName || 'Chủ tịch').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> đã phân công <strong>bạn</strong> làm phản biện cho hồ sơ: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
      '<p>Bạn vui lòng đăng nhập và hoàn thành phiếu đánh giá (SCI-TASK-06) theo quy định.</p>' +
      '<p><a href="' + councilUrl + '" style="color:#1565c0">Khu vực Hội đồng</a> | <a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    promises.push(transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: '[Đề tài cấp Viện Tế bào gốc]: Bạn được phân công phản biện: ' + submissionTitle,
      text: 'Bạn được phân công phản biện hồ sơ: ' + submissionTitle + '. ' + baseUrl,
      html: htmlYou
    }).catch(err => console.error('[Email] Lỗi gửi (phân công phản biện → PB):', err.message)));
  });
  const toList = getNotificationEmails();
  if (toList.length > 0) {
    promises.push(transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: toList.join(', '),
      subject: '[Đề tài cấp Viện Tế bào gốc]: Chủ tịch đã phân công phản biện (Bước 3): ' + submissionTitle,
      text: textAll,
      html: htmlAll
    }).catch(err => console.error('[Email] Lỗi gửi (phân công phản biện → HĐ):', err.message)));
  }
  return Promise.all(promises);
}

// Bước 3→4: Ngay sau khi Chủ tịch phân công phản biện — gửi Tổ thẩm định tài chính (to), CC Hội đồng khoa học
function sendCapVienStep4aNotifyBudgetTeamEmail(opts) {
  const { submissionTitle, submissionId } = opts;
  if (!transporter) return Promise.resolve();
  const budgetTeamEmails = getBudgetTeamEmails();
  const councilList = getNotificationEmails();
  if (!budgetTeamEmails || budgetTeamEmails.length === 0) {
    console.log('[Email] Bỏ qua gửi Tổ thẩm định: chưa có thành viên Tổ thẩm định tài chính trong hệ thống.');
    return Promise.resolve();
  }
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Đề tài cấp Viện Tế bào gốc]: Thông báo thẩm định dự toán (Bước 4A) — ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>Kính gửi Tổ thẩm định tài chính,</p>' +
    '<p>Hệ thống Quản lý KHCN&ĐMST Viện Tế bào gốc trân trọng thông báo: Đề tài <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> đã hoàn thành Bước 3 (Phân công phản biện) và chuyển sang Bước 4.</p>' +
    '<p>Đề nghị Tổ thẩm định tài chính thực hiện thẩm định dự toán theo quy định và nộp phiếu thẩm định (SCI-BUDGET-01, SCI-BUDGET-02) đúng hạn.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình đề tài</a></p>' +
    '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
  const text = 'Thông báo thẩm định dự toán: ' + submissionTitle + '. Đề nghị Tổ thẩm định thực hiện thẩm định theo quy định và nộp đúng hạn. ' + timelineUrl;
  const promises = [];
  promises.push(transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: budgetTeamEmails.join(', '),
    cc: councilList && councilList.length > 0 ? councilList.join(', ') : undefined,
    subject,
    text,
    html
  }).catch(err => console.error('[Email] Lỗi gửi (thông báo Tổ thẩm định 4A):', err.message)));
  return Promise.all(promises);
}

// Bước 4A: Tổ thẩm định yêu cầu bổ sung — gửi Chủ nhiệm (to), CC Hội đồng
function sendCapVienBudgetRevisionRequestEmail(opts) {
  const { submissionTitle, researcherEmail, researcherName, note, requestedByName, submissionId, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Đề tài cấp Viện Tế bào gốc]: Tổ thẩm định yêu cầu bổ sung/chỉnh sửa dự toán — ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>Kính gửi Chủ nhiệm đề tài,</p>' +
    '<p>Tổ thẩm định tài chính đã xem xét dự toán của đề tài <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> và yêu cầu bổ sung/chỉnh sửa như sau:</p>' +
    '<p style="background:#fff8e1;padding:12px;border-radius:8px;white-space:pre-wrap">' + (String(note || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' +
    '<p><strong>Người yêu cầu:</strong> ' + (String(requestedByName || '').replace(/</g, '&lt;')) + '</p>' +
    '<p>Quý Chủ nhiệm vui lòng đăng nhập hệ thống, truy cập trang theo dõi tiến trình và nộp lại tài liệu tài chính đã chỉnh sửa (Phiếu thẩm định SCI-BUDGET-01 và Tờ trình SCI-BUDGET-02).</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình đề tài</a></p>' +
    '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
  const text = 'Tổ thẩm định yêu cầu bổ sung dự toán: ' + submissionTitle + '\n\nNội dung: ' + (note || '') + '\n\n' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    promises.push(transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: researcherEmail, subject, text, html })
      .catch(err => console.error('[Email] Lỗi gửi (yêu cầu bổ sung dự toán → NCV):', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: councilList.join(', '), subject: '[CC] ' + subject, text, html })
      .catch(err => console.error('[Email] Lỗi gửi (yêu cầu bổ sung dự toán → HĐ):', err.message)));
  }
  return Promise.all(promises);
}

// Bước 4A: NCV nộp tài liệu chỉnh sửa — thông báo Hội đồng
function sendCapVienBudgetRevisedSubmittedEmail(opts) {
  const { submissionTitle, researcherName, submissionId, councilList } = opts;
  if (!transporter || !councilList || councilList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Đề tài cấp Viện Tế bào gốc]: Chủ nhiệm đã nộp tài liệu tài chính chỉnh sửa — ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>Kính gửi Quý thành viên Hội đồng,</p>' +
    '<p>Chủ nhiệm đề tài <strong>' + (String(researcherName || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> đã nộp tài liệu tài chính đã chỉnh sửa cho đề tài <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
    '<p>Tổ thẩm định tài chính sẽ kiểm tra và phê duyệt hoặc yêu cầu bổ sung tiếp.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình</a></p>' +
    '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
  const text = 'Chủ nhiệm đã nộp tài liệu tài chính chỉnh sửa: ' + submissionTitle + '. ' + timelineUrl;
  return transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: councilList.join(', '), subject, text, html })
    .catch(err => console.error('[Email] Lỗi gửi (NCV nộp chỉnh sửa dự toán):', err.message));
}

// Bước 4A: Tổ thẩm định phê duyệt — gửi Chủ nhiệm + Hội đồng
function sendCapVienBudgetApprovedEmail(opts) {
  const { submissionTitle, researcherEmail, researcherName, approvedByName, submissionId, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Đề tài cấp Viện Tế bào gốc]: Dự toán đã được thẩm định xong — ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>Kính gửi Quý thành viên Hội đồng,</p>' +
    '<p>Tổ thẩm định tài chính đã phê duyệt dự toán cho đề tài <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
    '<p><strong>Người phê duyệt:</strong> ' + (String(approvedByName || '').replace(/</g, '&lt;')) + '</p>' +
    '<p>Lưu ý: Bước 4 (Đánh giá phản biện) và Bước 4A (Thẩm định dự toán) thực hiện song song. Đề tài sẽ chuyển sang Bước 5 (Họp Hội đồng) khi cả hai bước đều hoàn thành.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình</a></p>' +
    '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
  const text = 'Dự toán đã được thẩm định xong: ' + submissionTitle + '. ' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    promises.push(transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: researcherEmail, subject, text, html })
      .catch(err => console.error('[Email] Lỗi gửi (phê duyệt dự toán → NCV):', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: councilList.join(', '), subject, text, html })
      .catch(err => console.error('[Email] Lỗi gửi (phê duyệt dự toán → HĐ):', err.message)));
  }
  return Promise.all(promises);
}

// Bước 4 & 4A đều hoàn thành → chuyển Bước 5 — thông báo Hội đồng (văn phong trang trọng)
function sendCapVienStep5ReadyEmail(opts) {
  const { submissionTitle, submissionId } = opts;
  if (!transporter) return Promise.resolve();
  const councilList = getNotificationEmails();
  if (!councilList || councilList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Đề tài cấp Viện Tế bào gốc]: Đề tài đã sẵn sàng Họp Hội đồng (Bước 5) — ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>Kính gửi Quý thành viên Hội đồng Khoa học và Công nghệ Viện Tế bào gốc,</p>' +
    '<p>Hệ thống Quản lý KHCN&ĐMST trân trọng thông báo: Đề tài <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> đã hoàn thành Bước 4 (Đánh giá phản biện) và Bước 4A (Thẩm định dự toán).</p>' +
    '<p>Đề tài hiện đã sẵn sàng chuyển sang <strong>Bước 5 – Họp Hội đồng Khoa học Viện</strong> để xem xét và biểu quyết.</p>' +
    '<p>Kính mong Quý Hội đồng sắp xếp thời gian và tham dự phiên họp theo quy định.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình đề tài</a></p>' +
    '<p>Trân trọng kính chào,<br>Hệ thống Quản lý Đề tài cấp Viện – Viện Tế bào gốc</p></div>';
  const text = 'Đề tài đã sẵn sàng Họp Hội đồng (Bước 5): ' + submissionTitle + '. ' + timelineUrl;
  return transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: councilList.join(', '), subject, text, html })
    .catch(err => console.error('[Email] Lỗi gửi (chuyển Bước 5):', err.message));
}

function sendStage3ResultEmail(submissionTitle, submittedByEmail, decision, comment, reviewerName) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const decisionLabels = { pass: 'Hợp lệ (chuyển GĐ4)', reject: 'Không chấp thuận', need_supplement: 'Yêu cầu bổ sung hồ sơ', need_revision: 'Yêu cầu sửa hồ sơ' };
  const label = decisionLabels[decision] || decision;
  const commentBlock = comment ? '<p><strong>Nhận xét / Yêu cầu:</strong></p><p>' + String(comment).replace(/\n/g, '<br>') + '</p>' : '';
  const needRevisionNote = (decision === 'need_supplement' || decision === 'need_revision')
    ? '<p><strong>Bạn cần chỉnh sửa và bổ sung hồ sơ theo nhận xét trên, sau đó nộp lại tại mục <a href="' + baseUrl + '/ho-so-cua-toi.html">Hồ sơ của tôi</a>.</strong></p>'
    : '';
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>Kết quả kiểm tra hồ sơ (GĐ3) tại Hệ thống SCI-ACE.</p>' +
    '<p><strong>Hồ sơ:</strong> ' + submissionTitle + '</p>' +
    '<p><strong>Người nộp:</strong> ' + submittedByEmail + '</p>' +
    '<p><strong>Kết quả:</strong> ' + label + '</p>' +
    (reviewerName ? '<p><strong>Người kiểm tra:</strong> ' + reviewerName + '</p>' : '') +
    commentBlock +
    needRevisionNote +
    '<p>Vui lòng đăng nhập <a href="' + baseUrl + '/hoi-dong.html">Khu vực Hội đồng</a> hoặc <a href="' + baseUrl + '/ho-so-cua-toi.html">Hồ sơ của tôi</a> để xem chi tiết.</p>' +
    '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
  const needRevisionText = (decision === 'need_supplement' || decision === 'need_revision')
    ? '\n\nBạn cần chỉnh sửa và bổ sung hồ sơ theo nhận xét trên, sau đó nộp lại tại Hồ sơ của tôi.'
    : '';
  const text = 'Kết quả kiểm tra hồ sơ (GĐ3): ' + submissionTitle + '\nKết quả: ' + label + (comment ? '\nNhận xét: ' + comment : '') + needRevisionText + '\n\n' + baseUrl;
  const promises = [];
  if (transporter) {
    promises.push(transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: submittedByEmail,
      subject: '[SCI-ACE] Kết quả kiểm tra hồ sơ: ' + submissionTitle,
      text,
      html
    }).catch(err => console.error('Email to researcher:', err.message)));
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: councilList.join(', '),
        subject: '[SCI-ACE] Thư ký đã xử lý GĐ3 – Hồ sơ: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email to council:', err.message)));
    }
  }
  return Promise.all(promises);
}

function sendStage4AssignmentEmail(submissionTitle, chairmanName, reviewerEmails, reviewerNames, note) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const reviewersList = reviewerNames && reviewerNames.length ? reviewerNames.join(', ') : (reviewerEmails && reviewerEmails.length ? reviewerEmails.join(', ') : '');
  const noteBlock = note ? '<p><strong>Ghi chú:</strong> ' + String(note).replace(/\n/g, '<br>') + '</p>' : '';
  const htmlAll = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>Chủ tịch Hội đồng <strong>' + (chairmanName || 'Chủ tịch') + '</strong> đã phân công phản biện cho hồ sơ: <strong>' + submissionTitle + '</strong>.</p>' +
    '<p><strong>Phản biện được phân công:</strong> ' + reviewersList + '</p>' +
    noteBlock +
    '<p>Giai đoạn đã chuyển sang <strong>GĐ5 – Đánh giá phản biện</strong>. Các thành viên được phân công cần upload phiếu đánh giá (SCI-ACE-PĐG).</p>' +
    '<p>Vui lòng đăng nhập <a href="' + baseUrl + '/hoi-dong.html">Khu vực Hội đồng</a> hoặc <a href="' + baseUrl + '/theo-doi-ho-so.html">Theo dõi tiến trình</a> để xem chi tiết.</p>' +
    '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
  const textAll = 'Chủ tịch đã phân công phản biện cho hồ sơ: ' + submissionTitle + '. Phản biện: ' + reviewersList + '. Giai đoạn chuyển sang GĐ5. ' + baseUrl;
  const promises = [];
  if (transporter) {
    reviewerEmails.forEach((email, i) => {
      const name = reviewerNames && reviewerNames[i] ? reviewerNames[i] : '';
      const htmlYou = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
        '<p>Kính gửi ' + (name || email) + ',</p>' +
        '<p>Chủ tịch Hội đồng <strong>' + (chairmanName || 'Chủ tịch') + '</strong> đã phân công <strong>bạn</strong> làm phản biện cho hồ sơ: <strong>' + submissionTitle + '</strong>.</p>' +
        noteBlock +
        '<p>Bạn vui lòng đăng nhập và thực hiện đánh giá (GĐ5), upload phiếu đánh giá SCI-ACE-PĐG theo quy định.</p>' +
        '<p><a href="' + baseUrl + '/hoi-dong.html">Khu vực Hội đồng</a> | <a href="' + baseUrl + '/theo-doi-ho-so.html">Theo dõi tiến trình</a></p>' +
        '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
      promises.push(transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: '[SCI-ACE] Bạn được phân công phản biện: ' + submissionTitle,
        text: 'Bạn được phân công phản biện hồ sơ: ' + submissionTitle + '. ' + baseUrl,
        html: htmlYou
      }).catch(err => console.error('Email to reviewer:', err.message)));
    });
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: councilList.join(', '),
        subject: '[SCI-ACE] Chủ tịch đã phân công phản biện (GĐ4) – Hồ sơ: ' + submissionTitle,
        text: textAll,
        html: htmlAll
      }).catch(err => console.error('Email to council GĐ4:', err.message)));
    }
  }
  return Promise.all(promises);
}

function sendDecisionIssuedEmail(submissionTitle, submittedByEmail, trackUrl) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const url = trackUrl || baseUrl + '/theo-doi-ho-so.html';
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>Thư ký Hội đồng đã cấp Quyết định (SCI-ACE-QĐ) cho hồ sơ: <strong>' + submissionTitle + '</strong>.</p>' +
    '<p>Quyết định có bản tiếng Việt và tiếng Anh. Vui lòng đăng nhập để tải về.</p>' +
    '<p><a href="' + url + '">Xem chi tiết và tải Quyết định</a></p>' +
    '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
  const text = 'Đã cấp Quyết định cho hồ sơ: ' + submissionTitle + '. Vui lòng đăng nhập để tải: ' + url;
  const promises = [];
  if (transporter) {
    if (submittedByEmail) {
      promises.push(transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: submittedByEmail,
        subject: '[SCI-ACE] Đã cấp Quyết định – Hồ sơ: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email decision to NCV:', err.message)));
    }
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: councilList.join(', '),
        subject: '[SCI-ACE] Đã cấp Quyết định – Hồ sơ: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email decision to council:', err.message)));
    }
  }
  return Promise.all(promises);
}

// GĐ5 (Họp Hội đồng): Thông báo kết quả họp cho nghiên cứu viên và toàn thể Hội đồng
function sendMeetingResultEmail(submissionTitle, submittedByEmail, decision, note, secretaryName) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const decisionLabels = { approved: 'Chấp thuận', conditional: 'Chấp thuận có điều kiện', rejected: 'Không chấp thuận' };
  const label = decisionLabels[decision] || decision;
  const noteBlock = note ? '<p><strong>Ghi chú:</strong> ' + String(note).replace(/\n/g, '<br>') + '</p>' : '';
  const nextStep = decision === 'rejected'
    ? 'Quy trình xét duyệt kết thúc tại đây.'
    : (decision === 'approved' ? 'Hồ sơ chuyển sang giai đoạn Cấp Quyết định (SCI-ACE-QĐ).' : 'Nghiên cứu viên cần nộp bản giải trình SCI-ACE-04, sau đó Chủ tịch Hội đồng xem xét thông qua.');
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>Kết quả họp Hội đồng (GĐ5) tại Hệ thống SCI-ACE.</p>' +
    '<p><strong>Hồ sơ:</strong> ' + submissionTitle + '</p>' +
    '<p><strong>Kết luận Hội đồng:</strong> ' + label + '</p>' +
    (secretaryName ? '<p><strong>Người ghi nhận:</strong> ' + secretaryName + '</p>' : '') +
    noteBlock +
    '<p><strong>Bước tiếp theo:</strong> ' + nextStep + '</p>' +
    '<p>Vui lòng đăng nhập <a href="' + baseUrl + '/theo-doi-ho-so.html">Theo dõi tiến trình</a> hoặc <a href="' + baseUrl + '/hoi-dong.html">Khu vực Hội đồng</a> để xem chi tiết.</p>' +
    '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
  const text = 'Kết quả họp Hội đồng (GĐ5): ' + submissionTitle + '\nKết luận: ' + label + '\n' + nextStep + (note ? '\nGhi chú: ' + note : '') + '\n\n' + baseUrl;
  const promises = [];
  if (transporter) {
    if (submittedByEmail) {
      promises.push(transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: submittedByEmail,
        subject: '[SCI-ACE] Kết quả họp Hội đồng – Hồ sơ: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email meeting result to researcher:', err.message)));
    }
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: councilList.join(', '),
        subject: '[SCI-ACE] Thư ký đã ghi nhận kết quả họp (GĐ5) – Hồ sơ: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email meeting result to council:', err.message)));
    }
  }
  return Promise.all(promises);
}

function sendConditionalSubmitEmail(submissionTitle, submittedByName, submissionId) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const trackUrl = baseUrl + '/theo-doi-ho-so.html?id=' + submissionId;
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>Nghiên cứu viên <strong>' + (submittedByName || 'NCV') + '</strong> đã nộp bản giải trình SCI-ACE-04 cho hồ sơ: <strong>' + submissionTitle + '</strong>.</p>' +
    '<p>Chủ tịch Hội đồng và các thành viên vui lòng đăng nhập để tải file và xem xét. Sau đó Chủ tịch sẽ quyết định Thông qua hoặc Không thông qua.</p>' +
    '<p><a href="' + trackUrl + '">Xem chi tiết và tải file giải trình</a></p>' +
    '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
  const text = 'NCV đã nộp SCI-ACE-04 cho hồ sơ: ' + submissionTitle + '. Vui lòng đăng nhập để xem xét: ' + trackUrl;
  const councilList = getNotificationEmails();
  if (!transporter || councilList.length === 0) return Promise.resolve();
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: councilList.join(', '),
    subject: '[SCI-ACE] NCV đã nộp bản giải trình SCI-ACE-04 – Hồ sơ: ' + submissionTitle,
    text,
    html
  }).catch(err => console.error('Email conditional submit to council:', err.message));
}

function sendConditionalRejectEmail(submissionTitle, submittedByEmail, chairmanName) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>Chủ tịch Hội đồng <strong>' + (chairmanName || 'Chủ tịch') + '</strong> chưa thông qua bản giải trình SCI-ACE-04 cho hồ sơ: <strong>' + submissionTitle + '</strong>.</p>' +
    '<p>Nghiên cứu viên vui lòng nộp lại tài liệu giải trình (SCI-ACE-04) theo yêu cầu. Sau khi nộp, Chủ tịch Hội đồng sẽ xem xét lại.</p>' +
    '<p>Vui lòng đăng nhập <a href="' + baseUrl + '/hoi-dong.html">Khu vực Hội đồng</a> hoặc <a href="' + baseUrl + '/ho-so-cua-toi.html">Hồ sơ của tôi</a> để xem chi tiết.</p>' +
    '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
  const text = 'Chủ tịch chưa thông qua bản giải trình SCI-ACE-04. NCV cần nộp lại. Hồ sơ: ' + submissionTitle + '. ' + baseUrl;
  const promises = [];
  if (transporter) {
    promises.push(transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: submittedByEmail,
      subject: '[SCI-ACE] Chưa thông qua bản giải trình – Hồ sơ: ' + submissionTitle,
      text,
      html
    }).catch(err => console.error('Email to NCV conditional reject:', err.message)));
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: councilList.join(', '),
        subject: '[SCI-ACE] Chủ tịch chưa thông qua bản giải trình – Hồ sơ: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email to council conditional reject:', err.message)));
    }
  }
  return Promise.all(promises);
}

function sendPasswordResetEmail(toEmail, resetToken) {
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const resetUrl = baseUrl + '/dat-lai-mat-khau.html?token=' + encodeURIComponent(resetToken);
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: '[SCI-ACE] Đặt lại mật khẩu',
    text: 'Bạn đã yêu cầu đặt lại mật khẩu. Mở link sau trong 1 giờ để đặt mật khẩu mới: ' + resetUrl,
    html: '<p>Bạn đã yêu cầu đặt lại mật khẩu.</p><p>Nhấn vào link sau để đặt mật khẩu mới (link có hiệu lực trong <strong>1 giờ</strong>):</p><p><a href="' + resetUrl + '">' + resetUrl + '</a></p><p>Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>'
  }).catch(err => console.error('Email reset error:', err.message));
}

const ROLE_LABELS = { chu_tich: 'Chủ tịch', thu_ky: 'Thư ký', thanh_vien: 'Thành viên Hội đồng', researcher: 'Nghiên cứu viên', admin: 'Admin', totruong_tham_dinh_tc: 'Tổ trưởng Tổ thẩm định TC', thanh_vien_tham_dinh_tc: 'Thành viên Tổ thẩm định TC' };

function sendRoleAssignmentEmail(toEmail, fullname, role, tempPassword) {
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const loginUrl = baseUrl + '/dang-nhap.html';
  const roleLabel = ROLE_LABELS[role] || role;
  const greeting = fullname ? 'Kính gửi ' + fullname + ',' : 'Kính gửi,';
  let passwordBlock = '';
  if (tempPassword) {
    passwordBlock = '<p><strong>Mật khẩu tạm để đăng nhập lần đầu:</strong> <code style="background:#f0f0f0;padding:4px 8px;">' + tempPassword + '</code></p><p>Bạn nên đổi mật khẩu sau khi đăng nhập (dùng chức năng <strong>Quên mật khẩu</strong> trên trang đăng nhập nếu cần đặt lại).</p>';
  } else {
    passwordBlock = '<p>Nếu bạn chưa có mật khẩu hoặc quên mật khẩu, vui lòng dùng chức năng <strong>Quên mật khẩu</strong> trên trang đăng nhập.</p>';
  }
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>' + greeting + '</p>' +
    '<p>Bạn đã được cấp vai trò <strong>' + roleLabel + '</strong> trong Hệ thống Hồ sơ Đạo đức Nghiên cứu Động vật (SCI-ACE), Viện Tế bào gốc, Trường Đại học Khoa học Tự nhiên, ĐHQG-HCM.</p>' +
    '<p><strong>Thông tin đăng nhập:</strong></p>' +
    '<p>• Email: ' + toEmail + '</p>' +
    passwordBlock +
    '<p><strong>Link đăng nhập:</strong> <a href="' + loginUrl + '">' + loginUrl + '</a></p>' +
    '<p>Sau khi đăng nhập, thành viên Hội đồng có thể vào <strong>Khu vực Hội đồng</strong> để xem và tải hồ sơ nghiên cứu viên đã nộp.</p>' +
    '<p>Trân trọng,<br>Hệ thống SCI-ACE</p>' +
    '</div>';
  const text = greeting + '\n\nBạn đã được cấp vai trò ' + roleLabel + ' trong Hệ thống SCI-ACE.\n\nThông tin đăng nhập:\n• Email: ' + toEmail + '\n' + (tempPassword ? '• Mật khẩu tạm: ' + tempPassword + '\n' : '') + '\nLink đăng nhập: ' + loginUrl + '\n\nTrân trọng,\nHệ thống SCI-ACE';
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: '[SCI-ACE] Bạn đã được cấp vai trò trong Hội đồng Đạo đức',
    text,
    html
  }).catch(err => console.error('Email role assignment error:', err.message));
}

// Middleware (static đặt sau API để /api/* luôn do API xử lý)
app.use(cors({ origin: '*' })); // Cho phép mọi origin (kể cả file:// khi mở từ ổ đĩa)
app.use(express.json());

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Chưa đăng nhập' });
  }
  try {
    const token = auth.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ message: 'Phiên đăng nhập hết hạn' });
  }
}

function thuyKyOrAdmin(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký Hội đồng hoặc Admin mới có quyền này' });
  }
  next();
}

function chuTichOrAdmin(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'chu_tich') {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng KHCN hoặc Admin mới có quyền này' });
  }
  next();
}

function adminOnly(req, res, next) {
  if ((req.user.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'Chỉ Admin mới có quyền này' });
  }
  next();
}

function adminOrPhongKhcn(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'phong_khcn' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Admin hoặc Phòng KHCN mới có quyền này' });
  }
  next();
}

// --- API ---

// Đăng ký (chỉ @sci.edu.vn)
app.post('/api/register', async (req, res) => {
  const { email, password, fullname } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'Chỉ chấp nhận email có đuôi ' + ALLOWED_EMAIL_DOMAIN });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ message: 'Mật khẩu ít nhất 6 ký tự' });
  }
  const role = 'researcher'; // Đăng ký mới luôn là researcher; Admin cấp vai trò Admin qua trang Quản trị
  try {
    db.prepare('INSERT INTO users (email, password, fullname, role) VALUES (?, ?, ?, ?)').run(em, hash, (fullname || '').trim(), role);
    return res.status(201).json({ message: 'Đăng ký thành công' });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ message: 'Email này đã được sử dụng' });
    }
    throw e;
  }
});

// Đăng nhập
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  const row = db.prepare('SELECT id, email, password, fullname, role FROM users WHERE email = ?').get(em);
  if (!row) {
    return res.status(401).json({ message: 'Email hoặc mật khẩu không đúng' });
  }
  const ok = await bcrypt.compare(password, row.password);
  if (!ok) {
    return res.status(401).json({ message: 'Email hoặc mật khẩu không đúng' });
  }
  const user = { id: row.id, email: row.email, fullname: row.fullname, role: row.role };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
  return res.json({ token, user });
});

// Quên mật khẩu: gửi email chứa link đặt lại (chỉ tài khoản tồn tại, không tiết lộ)
app.post('/api/forgot-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ message: 'Vui lòng nhập email' });
  }
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!row) {
    return res.json({ message: 'Nếu email tồn tại trong hệ thống, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu qua email.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM password_reset_tokens WHERE email = ?').run(email);
  db.prepare('INSERT INTO password_reset_tokens (token, email, expiresAt) VALUES (?, ?, ?)').run(token, email, expiresAt);
  await sendPasswordResetEmail(email, token);
  return res.json({ message: 'Nếu email tồn tại trong hệ thống, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu qua email.' });
});

// Đặt lại mật khẩu (sau khi nhấn link trong email)
app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 6) {
    return res.status(400).json({ message: 'Link không hợp lệ hoặc mật khẩu mới ít nhất 6 ký tự' });
  }
  const row = db.prepare('SELECT email FROM password_reset_tokens WHERE token = ? AND datetime(expiresAt) > datetime("now")').get(token);
  if (!row) {
    return res.status(400).json({ message: 'Link đã hết hạn hoặc không hợp lệ. Vui lòng yêu cầu quên mật khẩu lại.' });
  }
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, row.email);
  db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
  return res.json({ message: 'Đã đặt lại mật khẩu thành công. Bạn có thể đăng nhập bằng mật khẩu mới.' });
});

// Nộp hồ sơ (upload)
app.post('/api/submissions', authMiddleware, upload.fields([
  { name: 'sci_ace_01', maxCount: 1 },
  { name: 'sci_ace_02', maxCount: 1 },
  { name: 'sci_ace_03', maxCount: 1 },
  { name: 'attachments', maxCount: 10 }
]), (req, res) => {
  const title = (req.body.title || req.body.titleDisplay || '').trim();
  if (!title) {
    return res.status(400).json({ message: 'Vui lòng nhập tên đề tài / mã hồ sơ' });
  }
  const files = req.files || {};
  const f01 = files.sci_ace_01 && files.sci_ace_01[0];
  const f02 = files.sci_ace_02 && files.sci_ace_02[0];
  const f03 = files.sci_ace_03 && files.sci_ace_03[0];
  if (!f01 || !f02 || !f03) {
    return res.status(400).json({ message: 'Lần đầu nộp cần đủ 3 file: SCI-ACE-01, SCI-ACE-02, SCI-ACE-03' });
  }
  const run = db.transaction(() => {
    const sub = db.prepare('INSERT INTO submissions (title, submittedBy, submittedById) VALUES (?, ?, ?)').run(title, req.user.email, req.user.id);
    const subId = sub.lastInsertRowid;
    const researcherName = sanitizeFolderName(req.user.fullname) || sanitizeFolderName(req.user.email.split('@')[0]);
    const researcherFolder = researcherName + '_' + req.user.id;
    const finalDir = path.join(uploadDir, researcherFolder, 'submission_' + subId);
    fs.mkdirSync(finalDir, { recursive: true });
    const move = (f, fieldName) => {
      if (!f || !f.path) return;
      const newPath = path.join(finalDir, path.basename(f.path));
      try { fs.renameSync(f.path, newPath); } catch (e) { try { fs.copyFileSync(f.path, newPath); } catch (_) {} }
      const storedName = fixFilenameEncoding(f.originalname) || path.basename(f.path);
      db.prepare('INSERT INTO submission_files (submissionId, fieldName, originalName, path) VALUES (?, ?, ?, ?)').run(subId, fieldName, storedName, newPath);
    };
    move(f01, 'sci_ace_01');
    move(f02, 'sci_ace_02');
    move(f03, 'sci_ace_03');
    (files.attachments || []).forEach((f, i) => move(f, 'attachment_' + i));
    const tempDir = req._uploadDir;
    if (tempDir && fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
    }
    sendNotificationToCouncil(title, req.user.email);
    return subId;
  })();
  const id = Number(run);
  return res.status(201).json({ id, message: 'Đã gửi hồ sơ thành công' });
});

// Danh sách hồ sơ: Nghiên cứu viên chỉ thấy hồ sơ của mình; Hội đồng/Admin thấy tất cả (kèm họ tên NCV)
app.get('/api/submissions', authMiddleware, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache');
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  if (isCouncilOrAdmin) {
    const rows = db.prepare(`
      SELECT s.id, s.title, s.submittedBy, s.submittedById, s.createdAt, u.fullname AS submittedByName
      FROM submissions s
      LEFT JOIN users u ON s.submittedById = u.id
      ORDER BY s.createdAt DESC
    `).all();
    console.log('[API] GET /api/submissions (list) → ' + rows.length + ' hồ sơ, ids: ' + rows.map(r => r.id).join(', '));
    return res.json(rows);
  }
  if (role === 'researcher') {
    const rows = db.prepare('SELECT id, title, submittedBy, status, createdAt FROM submissions WHERE submittedById = ? ORDER BY createdAt DESC').all(req.user.id);
    return res.json(rows);
  }
  return res.status(403).json({ message: 'Bạn không có quyền xem danh sách hồ sơ' });
});

// Danh sách thành viên Hội đồng (Chủ tịch, Thư ký, Thành viên, Admin) — dùng cho form phân công GĐ4. Admin hiển thị vai trò "Ủy viên Hội đồng".
app.get('/api/users/council', authMiddleware, (req, res) => {
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  if (!isCouncilOrAdmin) return res.status(403).json({ message: 'Chỉ thành viên Hội đồng hoặc Admin mới xem được danh sách này' });
  const rows = db.prepare(
    "SELECT id, email, fullname, role FROM users WHERE role IN ('chu_tich','thu_ky','thanh_vien','admin') ORDER BY role, fullname, email"
  ).all();
  const council = rows.map(r => ({
    id: r.id,
    email: r.email,
    fullname: r.fullname,
    role: r.role,
    roleDisplay: r.role === 'admin' ? 'Ủy viên Hội đồng' : (ROLE_LABELS[r.role] || r.role)
  }));
  return res.json({ council });
});

// Chi tiết một hồ sơ (để trang theo dõi tiến trình): cùng quyền xem như danh sách
app.get('/api/submissions/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  console.log('[API] GET /api/submissions/' + id + ' — request received');
  try {
  res.set('Cache-Control', 'no-store, no-cache');
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const row = db.prepare(`
    SELECT s.id, s.title, s.submittedBy, s.submittedById, s.status, s.createdAt, s.reviewNote, s.reviewedAt, s.reviewedById,
      s.assignedReviewerIds, s.assignedAt, s.assignedById, s.assignNote,
      s.meetingNote, s.meetingDecisionAt, s.meetingDecisionById,
      s.conditionalSubmittedAt, s.conditionalSubmittedById, s.conditionalApprovedAt, s.conditionalApprovedById,
      u.fullname AS submittedByName, reviewer.fullname AS reviewedByName, chairman.fullname AS assignedByName,
      meetingUser.fullname AS meetingDecisionByName,
      condSubUser.fullname AS conditionalSubmittedByName,
      condApproveUser.fullname AS conditionalApprovedByName
    FROM submissions s
    LEFT JOIN users u ON s.submittedById = u.id
    LEFT JOIN users reviewer ON s.reviewedById = reviewer.id
    LEFT JOIN users chairman ON s.assignedById = chairman.id
    LEFT JOIN users meetingUser ON s.meetingDecisionById = meetingUser.id
    LEFT JOIN users condSubUser ON s.conditionalSubmittedById = condSubUser.id
    LEFT JOIN users condApproveUser ON s.conditionalApprovedById = condApproveUser.id
    WHERE s.id = ?
  `).get(id);
  if (!row) {
    console.log('[API] GET /api/submissions/' + id + ' → 404 (không có trong DB)');
    return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  }
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  const isOwner = row.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền xem hồ sơ này' });
  }
  let assignedReviewerNames = [];
  try {
    const ids = row.assignedReviewerIds ? JSON.parse(row.assignedReviewerIds) : [];
    if (Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const users = db.prepare('SELECT id, fullname, email FROM users WHERE id IN (' + placeholders + ')').all(...ids);
      assignedReviewerNames = ids.map(uid => {
        const u = users.find(r => r.id === uid);
        return u ? (u.fullname || u.email || '') : '';
      });
    }
  } catch (e) { /* ignore */ }
  let gd5ReviewHistory = [];
  try {
    const ids = row.assignedReviewerIds ? JSON.parse(row.assignedReviewerIds) : [];
    const gd5Files = db.prepare(
      "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName IN ('gd5_review_1','gd5_review_2')"
    ).all(id);
    const bySlot = {};
    gd5Files.forEach(f => { bySlot[f.fieldName] = f; });
    gd5ReviewHistory = [1, 2].map(slot => {
      const f = bySlot['gd5_review_' + slot];
      const reviewerName = assignedReviewerNames && assignedReviewerNames[slot - 1] ? assignedReviewerNames[slot - 1] : 'Phản biện ' + slot;
      return {
        slot,
        reviewerName,
        originalName: f ? f.originalName : null,
        uploadedAt: f ? f.uploadedAt : null
      };
    });
  } catch (e) { /* ignore */ }
  const submissionFiles = db.prepare(
    `SELECT fieldName, originalName FROM submission_files WHERE submissionId = ? 
     AND fieldName NOT IN ('gd5_review_1','gd5_review_2','meeting_minutes','conditional_sci_ace_04','decision_vn','decision_en') 
     AND fieldName NOT LIKE 'report_periodic_%' AND fieldName <> 'report_final' 
     ORDER BY fieldName`
  ).all(id);
  const meetingMinutesFile = db.prepare(
    "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'"
  ).get(id);
  const conditionalFile = db.prepare(
    "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'"
  ).get(id);
  let decisionIssuedAt = null;
  let decisionVnFile = null;
  let decisionEnFile = null;
  try {
    const decRow = db.prepare('SELECT decisionIssuedAt FROM submissions WHERE id = ?').get(id);
    if (decRow) decisionIssuedAt = decRow.decisionIssuedAt;
    decisionVnFile = db.prepare(
      "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'decision_vn'"
    ).get(id);
    decisionEnFile = db.prepare(
      "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'decision_en'"
    ).get(id);
  } catch (e) { /* decision columns/files might not exist yet */ }
  let gd5History = [];
  try {
    gd5History = db.prepare(
      'SELECT id, actionType, performedAt, performedByName, fileFieldName, originalFileName, label FROM submission_gd5_history WHERE submissionId = ? ORDER BY performedAt ASC'
    ).all(id);
  } catch (e) { /* table might not exist yet */ }
  const status = row.status || 'SUBMITTED';
  return res.json({
    id: row.id,
    title: row.title,
    submittedBy: row.submittedBy,
    submittedByName: row.submittedByName || null,
    status,
    createdAt: row.createdAt,
    reviewNote: row.reviewNote || null,
    reviewedAt: row.reviewedAt || null,
    reviewedByName: row.reviewedByName || null,
    assignedReviewerIds: row.assignedReviewerIds || null,
    assignedAt: row.assignedAt || null,
    assignedById: row.assignedById || null,
    assignedByName: row.assignedByName || null,
    assignNote: row.assignNote || null,
    assignedReviewerNames: assignedReviewerNames.length ? assignedReviewerNames : null,
    gd5ReviewHistory,
    submissionFiles,
    meetingNote: row.meetingNote || null,
    meetingDecisionAt: row.meetingDecisionAt || null,
    meetingDecisionByName: row.meetingDecisionByName || null,
    meetingMinutes: meetingMinutesFile ? { originalName: meetingMinutesFile.originalName, uploadedAt: meetingMinutesFile.uploadedAt } : null,
    conditionalSubmittedAt: row.conditionalSubmittedAt || null,
    conditionalSubmittedByName: row.conditionalSubmittedByName || null,
    conditionalApprovedAt: row.conditionalApprovedAt || null,
    conditionalApprovedByName: row.conditionalApprovedByName || null,
    conditionalFile: conditionalFile ? { originalName: conditionalFile.originalName, uploadedAt: conditionalFile.uploadedAt } : null,
    decisionVn: decisionVnFile ? { originalName: decisionVnFile.originalName, uploadedAt: decisionVnFile.uploadedAt } : null,
    decisionEn: decisionEnFile ? { originalName: decisionEnFile.originalName, uploadedAt: decisionEnFile.uploadedAt } : null,
    decisionIssuedAt: decisionIssuedAt || null,
    gd5History: gd5History || [],
    reportPeriodicFiles: (() => { try { return db.prepare("SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName LIKE 'report_periodic_%' ORDER BY fieldName").all(id); } catch (e) { return []; } })(),
    reportFinalFile: (() => { try { return db.prepare("SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'report_final'").get(id) || null; } catch (e) { return null; } })(),
    completedAt: (() => { try { const r = db.prepare('SELECT completedAt FROM submissions WHERE id = ?').get(id); return r ? r.completedAt : null; } catch (e) { return null; } })()
  });
  } catch (err) {
    console.error('[API] GET /api/submissions/' + (req.params.id) + ' error:', err);
    return res.status(500).json({ message: 'Lỗi máy chủ: ' + (err.message || 'Không xác định') });
  }
});

// Chấp thuận có điều kiện: NCV nộp SCI-ACE-04
app.post('/api/submissions/:id/conditional-submit', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'CONDITIONAL') {
    return res.status(400).json({ message: 'Chỉ có thể nộp SCI-ACE-04 khi hồ sơ ở trạng thái Chấp thuận có điều kiện' });
  }
  const isSubmitter = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSubmitter && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ nghiên cứu viên nộp hồ sơ hoặc Admin mới được nộp SCI-ACE-04' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file SCI-ACE-04 (PDF hoặc Word)' });
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word' });
  }
  const rawName = file.originalname || '';
  const originalName = fixFilenameEncoding(rawName) || 'sci-ace-04-' + id + ext;
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const finalPath = path.join(finalDir, 'conditional_sci_ace_04' + ext);
  try { fs.renameSync(file.path, finalPath); } catch (e) {
    try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
    try { fs.unlinkSync(file.path); } catch (_) {}
  }
  const existing = db.prepare("SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").get(id);
  if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) {
    try { fs.unlinkSync(existing.path); } catch (_) {}
  }
  const uploadedAt = new Date().toISOString();
  db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").run(id);
  db.prepare("INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, 'conditional_sci_ace_04', ?, ?, ?)")
    .run(id, originalName, finalPath, uploadedAt);
  db.prepare('UPDATE submissions SET conditionalSubmittedAt = ?, conditionalSubmittedById = ? WHERE id = ?')
    .run(uploadedAt, req.user.id, id);
  insertGd5History(id, 'conditional_upload', req.user.id, 'conditional_sci_ace_04', originalName, 'NCV nộp SCI-ACE-04');
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) { try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {} }
  const subForEmail = db.prepare('SELECT title FROM submissions WHERE id = ?').get(id);
  const performerName = (req.user.fullname || req.user.email || 'Nghiên cứu viên').toString();
  sendConditionalSubmitEmail(subForEmail ? subForEmail.title : 'Hồ sơ #' + id, performerName, id);
  console.log('[API] POST /api/submissions/' + id + '/conditional-submit — NCV đã nộp SCI-ACE-04');
  return res.json({ message: 'Đã nộp SCI-ACE-04. Chủ tịch Hội đồng sẽ xem xét và thông qua.' });
});

// Chấp thuận có điều kiện: Chủ tịch thông qua sau khi NCV đã nộp SCI-ACE-04
app.put('/api/submissions/:id/conditional-approve', authMiddleware, (req, res) => {
  const role = req.user.role;
  if (role !== 'admin' && role !== 'chu_tich') {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng hoặc Admin mới được thông qua' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, conditionalSubmittedAt FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'CONDITIONAL') {
    return res.status(400).json({ message: 'Chỉ có thể thông qua khi hồ sơ ở trạng thái Chấp thuận có điều kiện' });
  }
  if (!sub.conditionalSubmittedAt) {
    return res.status(400).json({ message: 'Nghiên cứu viên chưa nộp SCI-ACE-04. Vui lòng chờ NCV nộp trước khi thông qua.' });
  }
  const approvedAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, conditionalApprovedAt = ?, conditionalApprovedById = ? WHERE id = ?')
    .run('APPROVED', approvedAt, req.user.id, id);
  insertGd5History(id, 'conditional_approve', req.user.id, null, null, 'Chủ tịch thông qua');
  console.log('[API] PUT /api/submissions/' + id + '/conditional-approve — Chủ tịch đã thông qua');
  return res.json({ message: 'Đã thông qua. Hồ sơ chuyển sang giai đoạn Cấp Quyết định.' });
});

// Chấp thuận có điều kiện: Chủ tịch không thông qua → gửi email NCV + Hội đồng, xóa bản nộp để NCV nộp lại
app.put('/api/submissions/:id/conditional-reject', authMiddleware, (req, res) => {
  const role = req.user.role;
  if (role !== 'admin' && role !== 'chu_tich') {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng hoặc Admin mới được thực hiện thao tác này' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedBy, conditionalSubmittedAt FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'CONDITIONAL') {
    return res.status(400).json({ message: 'Chỉ có thể không thông qua khi hồ sơ ở trạng thái Chấp thuận có điều kiện' });
  }
  if (!sub.conditionalSubmittedAt) {
    return res.status(400).json({ message: 'Chưa có bản giải trình nào để xem xét.' });
  }
  const fileRow = db.prepare("SELECT id, path, originalName FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").get(id);
  if (fileRow && fileRow.path && fs.existsSync(fileRow.path)) {
    const versionCount = db.prepare("SELECT COUNT(*) as c FROM submission_files WHERE submissionId = ? AND fieldName LIKE 'conditional_sci_ace_04_v%'").get(id);
    const nextVer = (versionCount.c || 0) + 1;
    const newFieldName = 'conditional_sci_ace_04_v' + nextVer;
    const ext = path.extname(fileRow.path) || '.pdf';
    const newPath = path.join(path.dirname(fileRow.path), newFieldName + ext);
    try { fs.renameSync(fileRow.path, newPath); } catch (_) {
      try { fs.copyFileSync(fileRow.path, newPath); fs.unlinkSync(fileRow.path); } catch (__) {}
    }
    db.prepare("UPDATE submission_files SET fieldName = ?, path = ? WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").run(newFieldName, newPath, id);
    insertGd5History(id, 'conditional_reject', req.user.id, newFieldName, fileRow.originalName, 'Chủ tịch không thông qua (lần ' + nextVer + ')');
  } else {
    db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").run(id);
    insertGd5History(id, 'conditional_reject', req.user.id, null, null, 'Chủ tịch không thông qua');
  }
  db.prepare('UPDATE submissions SET conditionalSubmittedAt = NULL, conditionalSubmittedById = NULL WHERE id = ?').run(id);
  const chairmanName = (req.user.fullname || req.user.email || 'Chủ tịch').toString();
  sendConditionalRejectEmail(sub.title, sub.submittedBy, chairmanName);
  console.log('[API] PUT /api/submissions/' + id + '/conditional-reject — Chủ tịch chưa thông qua');
  return res.json({ message: 'Đã gửi thông báo đến NCV và Hội đồng. NCV cần nộp lại SCI-ACE-04.' });
});

// GĐ5 (Họp Hội đồng): Thư ký upload biên bản + chọn kết luận (Chấp thuận / Có điều kiện / Không chấp thuận)
app.put('/api/submissions/:id/meeting-result', authMiddleware, upload.single('file'), (req, res) => {
  const role = req.user.role;
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký Hội đồng hoặc Admin mới được thực hiện thao tác này' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedBy FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'IN_MEETING') {
    return res.status(400).json({ message: 'Chỉ có thể ghi nhận kết quả họp khi hồ sơ đang ở giai đoạn Họp Hội đồng' });
  }
  const decision = (req.body.decision || '').toLowerCase();
  if (!['approved', 'conditional', 'rejected'].includes(decision)) {
    return res.status(400).json({ message: 'Vui lòng chọn: Chấp thuận, Có điều kiện, hoặc Không chấp thuận' });
  }
  const note = (req.body.note || '').trim();
  const statusMap = { approved: 'APPROVED', conditional: 'CONDITIONAL', rejected: 'REJECTED' };
  const newStatus = statusMap[decision];
  const file = req.file;
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  if (file && file.path) {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase() || '.pdf';
    const rawName = file.originalname || '';
    const originalName = fixFilenameEncoding(rawName) || 'bien-ban-hop-' + id + ext;
    const safeExt = ['.pdf', '.docx', '.doc'].includes(ext) ? ext : '.pdf';
    const finalPath = path.join(finalDir, 'meeting_minutes' + safeExt);
    try {
      fs.renameSync(file.path, finalPath);
    } catch (e) {
      try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
    const existing = db.prepare("SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").get(id);
    if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) {
      try { fs.unlinkSync(existing.path); } catch (_) {}
    }
    const uploadedAt = new Date().toISOString();
    db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").run(id);
    db.prepare("INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, 'meeting_minutes', ?, ?, ?)")
      .run(id, originalName, finalPath, uploadedAt);
  }
  const meetingDecisionAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, meetingNote = ?, meetingDecisionAt = ?, meetingDecisionById = ? WHERE id = ?')
    .run(newStatus, note, meetingDecisionAt, req.user.id, id);
  const meetingFile = db.prepare("SELECT fieldName, originalName FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").get(id);
  insertGd5History(id, 'meeting_result', req.user.id, meetingFile ? 'meeting_minutes' : null, meetingFile ? meetingFile.originalName : null, newStatus === 'CONDITIONAL' ? 'Chấp thuận có điều kiện' : (newStatus === 'APPROVED' ? 'Chấp thuận' : 'Không chấp thuận'));
  const secretaryName = (req.user.fullname || req.user.email || 'Thư ký').toString();
  sendMeetingResultEmail(sub.title, sub.submittedBy || null, decision, note, secretaryName);
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) {
    try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
  }
  const msg = decision === 'rejected'
    ? 'Đã ghi nhận: Không chấp thuận. Email đã gửi đến nghiên cứu viên và Hội đồng.'
    : (decision === 'approved' ? 'Đã ghi nhận: Chấp thuận. Email đã gửi đến nghiên cứu viên và Hội đồng. Chuyển sang giai đoạn Cấp Quyết định.' : 'Đã ghi nhận: Chấp thuận có điều kiện. Email đã gửi đến nghiên cứu viên và Hội đồng.');
  console.log('[API] PUT /api/submissions/' + id + '/meeting-result — ' + newStatus);
  return res.json({ message: msg, status: newStatus });
});

// GĐ6 (Cấp Quyết định): Thư ký upload Quyết định VN + EN, chuyển sang IMPLEMENTATION
app.put('/api/submissions/:id/issue-decision', authMiddleware, upload.fields([
  { name: 'decision_vn', maxCount: 1 },
  { name: 'decision_en', maxCount: 1 }
]), (req, res) => {
  const role = req.user.role;
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký Hội đồng hoặc Admin mới được cấp Quyết định' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedBy FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'APPROVED') {
    return res.status(400).json({ message: 'Chỉ có thể cấp Quyết định khi hồ sơ đã được Hội đồng chấp thuận (trạng thái Đã phê duyệt)' });
  }
  const files = req.files || {};
  const fileVn = (files.decision_vn && files.decision_vn[0]) ? files.decision_vn[0] : null;
  const fileEn = (files.decision_en && files.decision_en[0]) ? files.decision_en[0] : null;
  if (!fileVn || !fileVn.path) return res.status(400).json({ message: 'Vui lòng chọn file Quyết định tiếng Việt' });
  if (!fileEn || !fileEn.path) return res.status(400).json({ message: 'Vui lòng chọn file Quyết định tiếng Anh' });
  const allowedExt = ['.pdf', '.docx', '.doc'];
  const extVn = (path.extname(fileVn.originalname || '') || '').toLowerCase();
  const extEn = (path.extname(fileEn.originalname || '') || '').toLowerCase();
  if (!allowedExt.includes(extVn)) { try { fs.unlinkSync(fileVn.path); } catch (_) {}; return res.status(400).json({ message: 'File Quyết định tiếng Việt: chỉ chấp nhận PDF hoặc Word' }); }
  if (!allowedExt.includes(extEn)) { try { fs.unlinkSync(fileEn.path); } catch (_) {}; return res.status(400).json({ message: 'File Quyết định tiếng Anh: chỉ chấp nhận PDF hoặc Word' }); }
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const saveFile = (file, fieldName, defaultName) => {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase() || '.pdf';
    const originalName = fixFilenameEncoding(file.originalname || '') || defaultName + ext;
    const safeExt = allowedExt.includes(ext) ? ext : '.pdf';
    const finalPath = path.join(finalDir, fieldName + safeExt);
    try { fs.renameSync(file.path, finalPath); } catch (e) {
      try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
    const existing = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = ?').get(id, fieldName);
    if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) { try { fs.unlinkSync(existing.path); } catch (_) {} }
    db.prepare('DELETE FROM submission_files WHERE submissionId = ? AND fieldName = ?').run(id, fieldName);
    db.prepare('INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, ?, ?, ?, ?)')
      .run(id, fieldName, originalName, finalPath, new Date().toISOString());
  };
  saveFile(fileVn, 'decision_vn', 'quyet-dinh-vn');
  saveFile(fileEn, 'decision_en', 'quyet-dinh-en');
  const issuedAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, decisionIssuedAt = ?, decisionIssuedById = ? WHERE id = ?')
    .run('IMPLEMENTATION', issuedAt, req.user.id, id);
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) { try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {} }
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const trackUrl = baseUrl + '/theo-doi-ho-so.html?id=' + id;
  sendDecisionIssuedEmail(sub.title, sub.submittedBy, trackUrl);
  console.log('[API] PUT /api/submissions/' + id + '/issue-decision — Đã cấp Quyết định');
  return res.json({ message: 'Đã cấp Quyết định. Email đã gửi đến NCV và Hội đồng.', status: 'IMPLEMENTATION' });
});

// GĐ7: NCV upload báo cáo định kỳ (SCI-ACE-07 định kỳ)
app.post('/api/submissions/:id/report-periodic', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'IMPLEMENTATION') {
    return res.status(400).json({ message: 'Chỉ có thể nộp báo cáo định kỳ khi hồ sơ đang ở giai đoạn Thực hiện' });
  }
  const isSubmitter = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSubmitter && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ nghiên cứu viên nộp hồ sơ hoặc Admin mới được nộp báo cáo định kỳ' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file báo cáo định kỳ (PDF hoặc Word)' });
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word' });
  }
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const count = db.prepare("SELECT COUNT(*) as c FROM submission_files WHERE submissionId = ? AND fieldName LIKE 'report_periodic_%'").get(id);
  const slot = (count.c || 0) + 1;
  const fieldName = 'report_periodic_' + slot;
  const originalName = fixFilenameEncoding(file.originalname || '') || 'bao-cao-dinh-ky-' + slot + ext;
  const safeExt = ['.pdf', '.docx', '.doc'].includes(ext) ? ext : '.pdf';
  const finalPath = path.join(finalDir, fieldName + safeExt);
  try { fs.renameSync(file.path, finalPath); } catch (e) {
    try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
    try { fs.unlinkSync(file.path); } catch (_) {}
  }
  db.prepare('INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, ?, ?, ?, ?)')
    .run(id, fieldName, originalName, finalPath, new Date().toISOString());
  console.log('[API] POST /api/submissions/' + id + '/report-periodic — Đã nộp báo cáo định kỳ #' + slot);
  return res.json({ message: 'Đã nộp báo cáo định kỳ.', fieldName, slot });
});

// GĐ7: NCV upload báo cáo kết thúc (SCI-ACE-07 kết thúc) → chuyển sang COMPLETED
app.post('/api/submissions/:id/report-final', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'IMPLEMENTATION') {
    return res.status(400).json({ message: 'Chỉ có thể nộp báo cáo kết thúc khi hồ sơ đang ở giai đoạn Thực hiện' });
  }
  const isSubmitter = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSubmitter && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ nghiên cứu viên nộp hồ sơ hoặc Admin mới được nộp báo cáo kết thúc' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file báo cáo kết thúc (PDF hoặc Word)' });
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word' });
  }
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const existing = db.prepare("SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = 'report_final'").get(id);
  if (existing && existing.path && fs.existsSync(existing.path)) {
    try { fs.unlinkSync(existing.path); } catch (_) {}
  }
  db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName = 'report_final'").run(id);
  const originalName = fixFilenameEncoding(file.originalname || '') || 'bao-cao-ket-thuc.pdf';
  const safeExt = ['.pdf', '.docx', '.doc'].includes(ext) ? ext : '.pdf';
  const finalPath = path.join(finalDir, 'report_final' + safeExt);
  try { fs.renameSync(file.path, finalPath); } catch (e) {
    try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
    try { fs.unlinkSync(file.path); } catch (_) {}
  }
  db.prepare("INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, 'report_final', ?, ?, ?)")
    .run(id, originalName, finalPath, new Date().toISOString());
  const completedAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, completedAt = ? WHERE id = ?').run('COMPLETED', completedAt, id);
  console.log('[API] POST /api/submissions/' + id + '/report-final — Đã nộp báo cáo kết thúc, hồ sơ hoàn thành');
  return res.json({ message: 'Đã nộp báo cáo kết thúc. Hồ sơ đã hoàn thành.', status: 'COMPLETED' });
});

// Tải một file trong hồ sơ (theo fieldName): Hội đồng/Admin hoặc chủ hồ sơ
app.get('/api/submissions/:id/file/:fieldName', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fieldName = (req.params.fieldName || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || !fieldName) return res.status(400).json({ message: 'Tham số không hợp lệ' });
  const sub = db.prepare('SELECT id, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền tải file này' });
  }
  const row = db.prepare('SELECT path, originalName FROM submission_files WHERE submissionId = ? AND fieldName = ?').get(id, fieldName);
  if (!row || !fs.existsSync(row.path)) return res.status(404).json({ message: 'Không tìm thấy file' });
  res.download(row.path, row.originalName || fieldName);
});

// Thư ký Hội đồng xử lý GĐ3 (kiểm tra hồ sơ): pass / reject / need_supplement / need_revision
app.put('/api/submissions/:id/review', authMiddleware, (req, res) => {
  console.log('[API] PUT /api/submissions/' + req.params.id + '/review');
  const role = req.user.role;
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký Hội đồng hoặc Admin mới được thực hiện thao tác này' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, submittedBy, status FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || 'SUBMITTED') !== 'SUBMITTED') {
    return res.status(400).json({ message: 'Hồ sơ này đã được xử lý tại GĐ3 trước đó' });
  }
  const { decision, comment } = req.body || {};
  const valid = ['pass', 'reject', 'need_supplement', 'need_revision'];
  if (!decision || !valid.includes(decision)) {
    return res.status(400).json({ message: 'Vui lòng chọn: pass, reject, need_supplement hoặc need_revision' });
  }
  const statusMap = { pass: 'VALIDATED', reject: 'REJECTED', need_supplement: 'NEED_REVISION', need_revision: 'NEED_REVISION' };
  const newStatus = statusMap[decision];
  const reviewedAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
    .run(newStatus, (comment || '').trim(), reviewedAt, req.user.id, id);
  const reviewerName = (req.user.fullname || req.user.email || 'Thư ký').toString();
  sendStage3ResultEmail(sub.title, sub.submittedBy, decision, (comment || '').trim(), reviewerName);
  return res.json({ message: 'Đã cập nhật kết quả kiểm tra. Email đã gửi đến nghiên cứu viên và Hội đồng.', status: newStatus });
});

// Chủ tịch Hội đồng phân công phản biện (GĐ4): ≥2 thành viên, lưu lịch sử, gửi email cho phản biện và toàn Hội đồng
app.put('/api/submissions/:id/assign-reviewers', authMiddleware, (req, res) => {
  console.log('[API] PUT /api/submissions/' + req.params.id + '/assign-reviewers');
  const role = req.user.role;
  if (role !== 'admin' && role !== 'chu_tich') {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng hoặc Admin mới được phân công phản biện' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, submittedBy, status FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'VALIDATED') {
    return res.status(400).json({ message: 'Chỉ có thể phân công phản biện khi hồ sơ ở trạng thái Đã kiểm tra (chờ phân công)' });
  }
  let reviewerIds = req.body && req.body.reviewerIds;
  if (!Array.isArray(reviewerIds)) reviewerIds = [];
  reviewerIds = reviewerIds.map(rid => parseInt(rid, 10)).filter(rid => rid > 0);
  const uniqueIds = [...new Set(reviewerIds)];
  if (uniqueIds.length < 2) {
    return res.status(400).json({ message: 'Vui lòng chọn ít nhất 2 phản biện (thành viên Hội đồng)' });
  }
  const councilIds = db.prepare("SELECT id FROM users WHERE role IN ('chu_tich','thu_ky','thanh_vien','admin')").all().map(r => r.id);
  const invalid = uniqueIds.filter(uid => !councilIds.includes(uid));
  if (invalid.length > 0) {
    return res.status(400).json({ message: 'Tất cả phản biện phải là thành viên Hội đồng (Chủ tịch, Thư ký, Thành viên) hoặc Admin' });
  }
  const note = (req.body && req.body.note) ? String(req.body.note).trim() : '';
  const assignedAt = new Date().toISOString();
  db.prepare(
    'UPDATE submissions SET status = ?, assignedReviewerIds = ?, assignedAt = ?, assignedById = ?, assignNote = ? WHERE id = ?'
  ).run('UNDER_REVIEW', JSON.stringify(uniqueIds), assignedAt, req.user.id, note, id);
  const chairmanName = (req.user.fullname || req.user.email || 'Chủ tịch').toString();
  const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + uniqueIds.map(() => '?').join(',') + ')').all(...uniqueIds);
  const reviewerEmails = reviewers.map(r => r.email);
  const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
  sendStage4AssignmentEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, note);
  return res.json({
    message: 'Đã phân công phản biện. Email đã gửi đến các phản biện và toàn thể Hội đồng. Giai đoạn chuyển sang GĐ5.',
    status: 'UNDER_REVIEW'
  });
});

// Admin: đưa hồ sơ về GĐ4 để Chủ tịch phân công lại phản biện (khi Chủ tịch yêu cầu điều chỉnh)
app.put('/api/submissions/:id/reset-gd4', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, assignedAt FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const status = sub.status || '';
  if (status !== 'UNDER_REVIEW') {
    return res.status(400).json({ message: 'Chỉ có thể đưa về GĐ4 khi hồ sơ đang ở giai đoạn Đang đánh giá (GĐ5). Trạng thái hiện tại: ' + status });
  }
  db.prepare(
    'UPDATE submissions SET status = ?, assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, assignNote = NULL WHERE id = ?'
  ).run('VALIDATED', id);
  console.log('[API] PUT /api/submissions/' + id + '/reset-gd4 — đã đưa về GĐ4');
  return res.json({
    message: 'Đã đưa hồ sơ về GĐ4. Chủ tịch Hội đồng có thể vào trang theo dõi và thực hiện lại phân công phản biện.',
    status: 'VALIDATED'
  });
});

// GĐ5: Danh sách file phản biện (2 slot) — để hiển thị / tải
app.get('/api/submissions/:id/review-files', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, assignedReviewerIds FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  let reviewerIdsCheck = [];
  try { reviewerIdsCheck = sub.assignedReviewerIds ? JSON.parse(sub.assignedReviewerIds) : []; } catch (e) {}
  const isAssignedReviewer = reviewerIdsCheck.includes(req.user.id);
  if (!isCouncilOrAdmin && !isAssignedReviewer) return res.status(403).json({ message: 'Chỉ thành viên Hội đồng hoặc phản biện được phân công mới xem được' });
  let reviewerIds = [];
  try { reviewerIds = sub.assignedReviewerIds ? JSON.parse(sub.assignedReviewerIds) : []; } catch (e) {}
  const reviewers = reviewerIds.length
    ? db.prepare('SELECT id, fullname, email FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds)
    : [];
  const files = db.prepare(
    "SELECT fieldName, originalName, path FROM submission_files WHERE submissionId = ? AND fieldName IN ('gd5_review_1','gd5_review_2')"
  ).all(id);
  const fileBySlot = {};
  files.forEach(f => { fileBySlot[f.fieldName] = f; });
  const result = [1, 2].map(slot => {
    const reviewerId = reviewerIds[slot - 1];
    const u = reviewers.find(r => r.id === reviewerId);
    const f = fileBySlot['gd5_review_' + slot];
    return {
      slot,
      reviewerId: reviewerId || null,
      reviewerName: u ? (u.fullname || u.email || '') : '—',
      originalName: f ? f.originalName : null,
      hasFile: !!f
    };
  });
  return res.json({ reviewFiles: result });
});

// GĐ5: Tải file phản biện (slot 1 hoặc 2)
app.get('/api/submissions/:id/review-file/:slot', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt(req.params.slot, 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'Tham số không hợp lệ' });
  const sub = db.prepare('SELECT id, assignedReviewerIds FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  let reviewerIds = [];
  try { reviewerIds = sub.assignedReviewerIds ? JSON.parse(sub.assignedReviewerIds) : []; } catch (e) {}
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  const isReviewerForSlot = reviewerIds[slot - 1] === req.user.id;
  if (!isCouncilOrAdmin && !isReviewerForSlot) return res.status(403).json({ message: 'Không có quyền tải file này' });
  const row = db.prepare(
    'SELECT path, originalName FROM submission_files WHERE submissionId = ? AND fieldName = ?'
  ).get(id, 'gd5_review_' + slot);
  if (!row || !fs.existsSync(row.path)) return res.status(404).json({ message: 'Không tìm thấy file phản biện' });
  res.download(row.path, row.originalName || 'phản biện ' + slot + '.pdf');
});

// GĐ5: Phản biện upload file đánh giá (PDF/docx có chữ ký hoặc bản scan)
app.post('/api/submissions/:id/review-upload', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, assignedReviewerIds FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'UNDER_REVIEW') {
    return res.status(400).json({ message: 'Chỉ có thể nộp file phản biện khi hồ sơ đang ở GĐ5 (Đang đánh giá)' });
  }
  let reviewerIds = [];
  try { reviewerIds = sub.assignedReviewerIds ? JSON.parse(sub.assignedReviewerIds) : []; } catch (e) {}
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  const bodySlot = req.body.slot != null ? parseInt(req.body.slot, 10) : NaN;
  const slotIndex = reviewerIds.indexOf(req.user.id);
  let slot;
  if (isAdmin && (bodySlot === 1 || bodySlot === 2)) {
    slot = bodySlot;
  } else if (slotIndex !== -1) {
    slot = slotIndex + 1;
  } else {
    return res.status(403).json({ message: 'Chỉ phản biện được phân công hoặc Admin mới được nộp file đánh giá. Admin cần chọn đúng ô slot 1 hoặc 2.' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file (PDF hoặc docx)' });
  const rawName = file.originalname || '';
  const originalName = fixFilenameEncoding(rawName) || path.basename(file.path);
  const ext = (path.extname(originalName) || '').toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word (docx/doc)' });
  }
  const existing = db.prepare(
    'SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = ?'
  ).get(id, 'gd5_review_' + slot);
  let finalPath = file.path;
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  if (firstFile && firstFile.path) {
    const finalDir = path.dirname(firstFile.path);
    const safeName = 'gd5_review_' + slot + ext;
    finalPath = path.join(finalDir, safeName);
    fs.mkdirSync(finalDir, { recursive: true });
    try {
      fs.renameSync(file.path, finalPath);
    } catch (e) {
      try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
  }
  if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) {
    try { fs.unlinkSync(existing.path); } catch (_) {}
  }
  const uploadedAt = new Date().toISOString();
  db.prepare('DELETE FROM submission_files WHERE submissionId = ? AND fieldName = ?').run(id, 'gd5_review_' + slot);
  db.prepare(
    'INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, ?, ?, ?, ?)'
  ).run(id, 'gd5_review_' + slot, originalName, finalPath, uploadedAt);
  const bothDone = db.prepare(
    "SELECT 1 FROM submission_files WHERE submissionId = ? AND fieldName IN ('gd5_review_1','gd5_review_2')"
  ).all(id);
  if (bothDone.length >= 2) {
    db.prepare('UPDATE submissions SET status = ? WHERE id = ?').run('IN_MEETING', id);
    console.log('[API] Cả 2 phản biện đã nộp — chuyển hồ sơ ' + id + ' sang GĐ6 (IN_MEETING)');
  }
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) {
    try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
  }
  console.log('[API] POST /api/submissions/' + id + '/review-upload — slot ' + slot);
  return res.json({
    message: bothDone.length >= 2
      ? 'Đã nộp file đánh giá. Cả 2 phản biện đã nộp xong — hồ sơ chuyển sang GĐ6 (Họp Hội đồng).'
      : 'Đã nộp file đánh giá phản biện. Các thành viên Hội đồng có thể xem và tải file.',
    slot,
    originalName,
    status: bothDone.length >= 2 ? 'IN_MEETING' : undefined
  });
});

// Tải hồ sơ: Nghiên cứu viên chỉ tải được hồ sơ của mình; Hội đồng/Admin tải được mọi hồ sơ (không cho sửa)
app.get('/api/submissions/:id/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = db.prepare('SELECT id, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền tải hồ sơ này' });
  }
  const files = db.prepare('SELECT path, originalName FROM submission_files WHERE submissionId = ?').all(id);
  if (files.length === 0) return res.status(404).json({ message: 'Không tìm thấy file hồ sơ' });
  if (files.length === 1) return res.download(files[0].path, files[0].originalName);
  try {
    const archiver = require('archiver');
    res.attachment('ho-so-' + id + '.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    files.forEach(f => archive.file(f.path, { name: f.originalName }));
    archive.finalize();
  } catch (e) {
    res.download(files[0].path, files[0].originalName);
  }
});

// Xóa hồ sơ: chỉ Admin
app.delete('/api/submissions/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const files = db.prepare('SELECT path FROM submission_files WHERE submissionId = ?').all(id);
  const submissionDir = files.length > 0 ? path.dirname(files[0].path) : null;
  db.transaction(() => {
    db.prepare('DELETE FROM submission_files WHERE submissionId = ?').run(id);
    db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
  })();
  if (submissionDir && fs.existsSync(submissionDir)) {
    try { fs.rmSync(submissionDir, { recursive: true }); } catch (e) { /* ignore */ }
  }
  return res.json({ message: 'Đã xóa hồ sơ' });
});

// ========== API Đề tài cấp Viện (Nhiệm vụ KHCN cấp cơ sở) — DB và upload riêng ==========
app.post('/api/cap-vien/submissions', authMiddleware, uploadCapVien.fields([
  { name: 'sci_ace_01', maxCount: 1 },
  { name: 'sci_ace_02', maxCount: 1 },
  { name: 'sci_ace_03', maxCount: 1 },
  { name: 'attachments', maxCount: 10 }
]), (req, res) => {
  const title = (req.body.title || req.body.titleDisplay || '').trim();
  if (!title) {
    return res.status(400).json({ message: 'Vui lòng nhập tên đề tài / mã hồ sơ' });
  }
  const files = req.files || {};
  const f01 = files.sci_ace_01 && files.sci_ace_01[0];
  const f02 = files.sci_ace_02 && files.sci_ace_02[0];
  const f03 = files.sci_ace_03 && files.sci_ace_03[0];
  if (!f01 || !f02 || !f03) {
    return res.status(400).json({ message: 'Cần đủ 3 file: Thuyết minh, Kế hoạch, Tài liệu bổ sung' });
  }
  let optionsChecked = [];
  try {
    const raw = req.body.options_checked;
    if (raw) optionsChecked = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw || '[]') : []);
  } catch (e) { optionsChecked = []; }
  if (!Array.isArray(optionsChecked)) optionsChecked = [];

  const run = dbCapVien.transaction(() => {
    const year = new Date().getFullYear();
    const countRow = dbCapVien.prepare('SELECT COUNT(*) AS n FROM cap_vien_submissions WHERE createdAt >= ? AND createdAt < ?').get(year + '-01-01', (year + 1) + '-01-01');
    const seq = (countRow && countRow.n != null ? countRow.n : 0) + 1;
    const baseCode = 'DTSCI-' + year + '-' + String(seq).padStart(3, '0');
    const optsWithAffect = dbCapVien.prepare('SELECT code FROM cap_vien_submission_options WHERE affects_code = 1').all();
    const affectCodes = optsWithAffect.map(r => (r.code || '').toUpperCase()).filter(Boolean);
    const checkedAffect = optionsChecked.filter(c => affectCodes.includes((c || '').toUpperCase()));
    let code = baseCode;
    if (checkedAffect.length > 0) {
      const suffix = (checkedAffect[0] || '').toUpperCase();
      code = 'DTSCI-' + suffix + '-' + year + '-' + String(seq).padStart(3, '0');
    }
    const optionsCheckedJson = JSON.stringify(optionsChecked);
    const sub = dbCapVien.prepare('INSERT INTO cap_vien_submissions (title, submittedBy, submittedById, code, options_checked) VALUES (?, ?, ?, ?, ?)').run(title, req.user.email, req.user.id, code, optionsCheckedJson);
    const subId = sub.lastInsertRowid;
    const researcherName = sanitizeFolderName(req.user.fullname) || sanitizeFolderName(req.user.email.split('@')[0]);
    const researcherFolder = researcherName + '_' + req.user.id;
    const finalDir = path.join(uploadDirCapVien, researcherFolder, 'submission_' + subId);
    fs.mkdirSync(finalDir, { recursive: true });
    const move = (f, fieldName) => {
      if (!f || !f.path) return;
      const newPath = path.join(finalDir, path.basename(f.path));
      try { fs.renameSync(f.path, newPath); } catch (e) { try { fs.copyFileSync(f.path, newPath); } catch (_) {} }
      const storedName = fixFilenameEncoding(f.originalname) || path.basename(f.path);
      dbCapVien.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound) VALUES (?, ?, ?, ?, 0)').run(subId, fieldName, storedName, newPath);
    };
    move(f01, 'thuyet_minh');
    move(f02, 'ke_hoach');
    move(f03, 'tai_lieu_bo_sung');
    (files.attachments || []).forEach((f, i) => move(f, 'attachment_' + i));
    const tempDir = req._uploadDirCapVien;
    if (tempDir && fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
    }
    return subId;
  })();
  const id = Number(run);
  const row = dbCapVien.prepare('SELECT createdAt, status FROM cap_vien_submissions WHERE id = ?').get(id);
  insertCapVienHistory(id, '1', 'researcher_submit', req.user.id, 'researcher', 'Nghiên cứu viên nộp hồ sơ đề xuất', row ? row.createdAt : null);
  sendCapVienNewSubmissionEmail({
    submissionId: id,
    submissionTitle: title,
    submittedByEmail: req.user.email,
    submittedByName: req.user.fullname,
    createdAt: row ? row.createdAt : null,
    status: row ? row.status : 'SUBMITTED'
  });
  return res.status(201).json({ id, message: 'Đã gửi hồ sơ đề tài cấp Viện thành công' });
});

// Ô đánh dấu khi nộp đề tài cấp Viện (CoE, Kinh phí Viện...) — public để form hiển thị
app.get('/api/cap-vien/submission-options', (req, res) => {
  const rows = dbCapVien.prepare('SELECT id, code, label, affects_code FROM cap_vien_submission_options ORDER BY sort_order ASC, id ASC').all();
  return res.json({ options: rows || [] });
});

// Danh mục hạng mục (public, dùng trong form nộp hồ sơ)
app.get('/api/cap-vien/linh-vuc', (req, res) => {
  const rows = dbCapVien.prepare('SELECT id, code, label FROM cap_vien_linh_vuc ORDER BY sort_order ASC, id ASC').all();
  return res.json({ items: rows || [] });
});
app.get('/api/cap-vien/loai-de-tai', (req, res) => {
  const rows = dbCapVien.prepare('SELECT id, code, label FROM cap_vien_loai_de_tai ORDER BY sort_order ASC, id ASC').all();
  return res.json({ items: rows || [] });
});
app.get('/api/cap-vien/don-vi', (req, res) => {
  const rows = dbCapVien.prepare('SELECT id, code, label FROM cap_vien_don_vi ORDER BY sort_order ASC, id ASC').all();
  return res.json({ items: rows || [] });
});
app.get('/api/cap-vien/khoan-muc-chi', (req, res) => {
  const rows = dbCapVien.prepare('SELECT id, code, label, parent_code FROM cap_vien_khoan_muc_chi ORDER BY sort_order ASC, id ASC').all();
  return res.json({ items: rows || [] });
});

// Admin: CRUD ô đánh dấu
app.get('/api/admin/cap-vien/submission-options', authMiddleware, adminOnly, (req, res) => {
  const rows = dbCapVien.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options ORDER BY sort_order ASC, id ASC').all();
  return res.json({ options: rows || [] });
});
app.post('/api/admin/cap-vien/submission-options', authMiddleware, adminOnly, (req, res) => {
  const { code, label, affects_code } = req.body || {};
  const codeStr = (code != null ? String(code).trim() : '').replace(/\s+/g, '_');
  const labelStr = (label != null ? String(label).trim() : '') || codeStr;
  if (!codeStr) return res.status(400).json({ message: 'Mã option không được để trống' });
  try {
    const maxOrder = dbCapVien.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM cap_vien_submission_options').get();
    const nextOrder = (maxOrder && maxOrder.m != null ? maxOrder.m : 0) + 1;
    dbCapVien.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run(codeStr, labelStr, affects_code ? 1 : 0, nextOrder);
    const row = dbCapVien.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options WHERE code = ?').get(codeStr);
    return res.status(201).json({ message: 'Đã thêm ô đánh dấu', option: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Mã option đã tồn tại' });
    throw e;
  }
});
app.put('/api/admin/cap-vien/submission-options/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { code, label, affects_code, sort_order } = req.body || {};
  const row = dbCapVien.prepare('SELECT id FROM cap_vien_submission_options WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy option' });
  const codeStr = (code != null ? String(code).trim() : '').replace(/\s+/g, '_');
  const labelStr = (label != null ? String(label).trim() : '');
  const updates = [];
  const params = [];
  if (codeStr !== '') { updates.push('code = ?'); params.push(codeStr); }
  if (labelStr !== '') { updates.push('label = ?'); params.push(labelStr); }
  if (affects_code !== undefined) { updates.push('affects_code = ?'); params.push(affects_code ? 1 : 0); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(parseInt(sort_order, 10) || 0); }
  if (updates.length === 0) return res.json({ message: 'Không có thay đổi' });
  params.push(id);
  dbCapVien.prepare('UPDATE cap_vien_submission_options SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
  const updated = dbCapVien.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options WHERE id = ?').get(id);
  return res.json({ message: 'Đã cập nhật', option: updated });
});
app.delete('/api/admin/cap-vien/submission-options/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = dbCapVien.prepare('SELECT id FROM cap_vien_submission_options WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy option' });
  dbCapVien.prepare('DELETE FROM cap_vien_submission_options WHERE id = ?').run(id);
  return res.json({ message: 'Đã xóa ô đánh dấu' });
});

// Admin: CRUD Lĩnh vực KHCN
function crudCapVienTable(tableName, singularLabel) {
  const table = 'cap_vien_' + tableName;
  app.get('/api/admin/cap-vien/' + tableName, authMiddleware, adminOnly, (req, res) => {
    const rows = dbCapVien.prepare('SELECT id, code, label, sort_order' + (tableName === 'khoan_muc_chi' ? ', parent_code' : '') + ' FROM ' + table + ' ORDER BY sort_order ASC, id ASC').all();
    return res.json({ items: rows });
  });
  app.post('/api/admin/cap-vien/' + tableName, authMiddleware, adminOnly, (req, res) => {
    const { code, label, parent_code } = req.body || {};
    const codeStr = (code || '').toString().trim().replace(/\s+/g, '_');
    const labelStr = (label || codeStr || '').toString().trim();
    if (!codeStr) return res.status(400).json({ message: 'Mã không được để trống' });
    const maxOrder = dbCapVien.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM ' + table).get();
    try {
      if (tableName === 'khoan_muc_chi') {
        dbCapVien.prepare('INSERT INTO ' + table + ' (code, label, parent_code, sort_order) VALUES (?, ?, ?, ?)').run(codeStr, labelStr, (parent_code || '').trim() || null, (maxOrder.m || 0) + 1);
      } else {
        dbCapVien.prepare('INSERT INTO ' + table + ' (code, label, sort_order) VALUES (?, ?, ?)').run(codeStr, labelStr, (maxOrder.m || 0) + 1);
      }
      const row = dbCapVien.prepare('SELECT * FROM ' + table + ' WHERE code = ?').get(codeStr);
      return res.json({ message: 'Đã thêm ' + singularLabel, item: row });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ message: 'Mã đã tồn tại' });
      throw e;
    }
  });
  app.put('/api/admin/cap-vien/' + tableName + '/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { code, label, parent_code, sort_order } = req.body || {};
    const row = dbCapVien.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const updates = [];
    const params = [];
    if (code != null) { updates.push('code = ?'); params.push(String(code).trim().replace(/\s+/g, '_')); }
    if (label != null) { updates.push('label = ?'); params.push(String(label).trim()); }
    if (parent_code !== undefined && tableName === 'khoan_muc_chi') { updates.push('parent_code = ?'); params.push((parent_code || '').trim() || null); }
    if (sort_order != null) { updates.push('sort_order = ?'); params.push(parseInt(sort_order, 10)); }
    if (updates.length) {
      params.push(id);
      dbCapVien.prepare('UPDATE ' + table + ' SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
    }
    const updated = dbCapVien.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(id);
    return res.json({ message: 'Đã cập nhật', item: updated });
  });
  app.delete('/api/admin/cap-vien/' + tableName + '/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = dbCapVien.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    dbCapVien.prepare('DELETE FROM ' + table + ' WHERE id = ?').run(id);
    return res.json({ message: 'Đã xóa ' + singularLabel });
  });
}
crudCapVienTable('linh_vuc', 'lĩnh vực');
crudCapVienTable('loai_de_tai', 'loại đề tài');
crudCapVienTable('don_vi', 'đơn vị');
crudCapVienTable('khoan_muc_chi', 'khoản mục chi');

// Admin: đồng bộ nhiệm vụ KHCN từ đề tài cấp Viện
app.post('/api/admin/missions/sync-from-cap-vien', authMiddleware, adminOnly, (req, res) => {
  syncMissionsFromCapVien();
  const count = db.prepare('SELECT COUNT(*) AS n FROM missions WHERE source_type = ?').get('cap_vien');
  return res.json({ message: 'Đã đồng bộ nhiệm vụ KHCN từ đề tài cấp Viện.', count: count.n });
});

// Admin: danh sách đề tài cấp Viện (đầy đủ, cho quản trị)
app.get('/api/admin/cap-vien/submissions', authMiddleware, adminOnly, (req, res) => {
  const rows = dbCapVien.prepare('SELECT id, title, submittedBy, submittedById, status, createdAt, code FROM cap_vien_submissions ORDER BY createdAt DESC').all();
  rows.forEach(r => {
    const u = db.prepare('SELECT fullname FROM users WHERE id = ?').get(r.submittedById);
    r.submittedByName = u ? u.fullname : null;
  });
  return res.json({ submissions: rows });
});

// Admin: sửa mã đề tài (trường hợp cần thiết)
app.put('/api/admin/cap-vien/submissions/:id/code', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const newCode = (req.body && req.body.code != null) ? String(req.body.code).trim() : '';
  const row = dbCapVien.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if (!newCode) return res.status(400).json({ message: 'Mã đề tài không được để trống' });
  dbCapVien.prepare('UPDATE cap_vien_submissions SET code = ? WHERE id = ?').run(newCode, id);
  return res.json({ message: 'Đã cập nhật mã đề tài', code: newCode });
});

app.get('/api/cap-vien/submissions', authMiddleware, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache');
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  if (isCouncilOrAdmin) {
    const rows = dbCapVien.prepare('SELECT id, title, submittedBy, submittedById, status, createdAt, code FROM cap_vien_submissions ORDER BY createdAt DESC').all();
    rows.forEach(r => {
      const u = db.prepare('SELECT fullname FROM users WHERE id = ?').get(r.submittedById);
      r.submittedByName = u ? u.fullname : null;
    });
    return res.json(rows);
  }
  const rows = dbCapVien.prepare('SELECT id, title, submittedBy, status, createdAt, code FROM cap_vien_submissions WHERE submittedById = ? ORDER BY createdAt DESC').all(req.user.id);
  return res.json(rows);
});

app.get('/api/cap-vien/submissions/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const row = dbCapVien.prepare('SELECT id, title, submittedBy, submittedById, status, createdAt, code, options_checked, reviewNote, reviewedAt, reviewedById, assignedReviewerIds, assignedAt, assignedById, budget_4a_status, budget_4a_revision_note, budget_4a_revision_requested_at, budget_4a_revision_requested_by, budget_4a_approved_at, budget_4a_approved_by, step_4_reviewer1_done, step_4_reviewer2_done FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  const isOwner = row.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền xem hồ sơ này' });
  }
  const u = db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.submittedById);
  const files = dbCapVien.prepare('SELECT id, fieldName, originalName, path, COALESCE(revisionRound, 0) AS revisionRound FROM cap_vien_submission_files WHERE submissionId = ? ORDER BY revisionRound ASC, id ASC').all(id);
  const reviewedBy = (row.reviewedById != null) ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.reviewedById) : null;
  const allHistory = dbCapVien.prepare('SELECT stepId, actionType, performedAt, performedById, performedByName, performedByRole, note FROM cap_vien_submission_history WHERE submissionId = ? ORDER BY performedAt ASC').all(id);
  const stepHistory = {};
  allHistory.forEach(h => {
    if (!stepHistory[h.stepId]) stepHistory[h.stepId] = [];
    stepHistory[h.stepId].push({ actionType: h.actionType, performedAt: h.performedAt, performedById: h.performedById, performedByName: h.performedByName, performedByRole: h.performedByRole, note: h.note });
  });
  let step2History = (stepHistory['2'] || []);
  if (step2History.length === 0) {
    const legacy = dbCapVien.prepare('SELECT actionType, performedAt, performedById, performedByName, performedByRole, note FROM cap_vien_step2_history WHERE submissionId = ? ORDER BY performedAt ASC').all(id);
    if (legacy.length) step2History = legacy;
    else if (row.reviewedAt && row.reviewedById) {
      const actionType = (row.status || '').toUpperCase() === 'VALIDATED' ? 'secretary_approve' : 'secretary_request_revision';
      const note = row.reviewNote || (actionType === 'secretary_approve' ? 'Hợp lệ' : null);
      const revUser = db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.reviewedById);
      step2History = [{ actionType, performedAt: row.reviewedAt, performedById: row.reviewedById, performedByName: revUser ? revUser.fullname : '', performedByRole: 'secretary', note }];
    }
  }
  stepHistory['2'] = step2History;
  let assignedBy = null;
  let reviewerNames = [];
  if (row.assignedById) assignedBy = db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.assignedById);
  if (row.assignedReviewerIds) {
    try {
      const ids = JSON.parse(row.assignedReviewerIds);
      const reviewers = db.prepare('SELECT id, fullname, email FROM users WHERE id IN (' + ids.map(() => '?').join(',') + ')').all(...ids);
      reviewerNames = ids.map(rid => { const r = reviewers.find(x => x.id === rid); return r ? (r.fullname || r.email || '') : '—'; });
    } catch (e) {}
  }
  let displayCode = row.code;
  if (!displayCode && row.id) {
    const y = (row.createdAt || '').toString().slice(0, 4) || new Date().getFullYear();
    displayCode = 'DTSCI-' + y + '-' + String(row.id).padStart(3, '0');
  }
  return res.json({
    ...row,
    code: displayCode,
    submittedByName: u ? u.fullname : null,
    reviewedByName: reviewedBy ? reviewedBy.fullname : null,
    assignedByName: assignedBy ? assignedBy.fullname : null,
    reviewerNames,
    files,
    step2History,
    stepHistory
  });
});

// Danh sách thành viên Hội đồng KHCN (Chủ tịch, Thư ký, Thành viên) — để Chủ tịch phân công phản biện
app.get('/api/cap-vien/council', authMiddleware, (req, res) => {
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  if (!isCouncilOrAdmin) return res.status(403).json({ message: 'Chỉ thành viên Hội đồng hoặc Admin mới xem được danh sách' });
  const rows = db.prepare(
    "SELECT id, email, fullname, role FROM users WHERE role IN ('chu_tich','thu_ky','thanh_vien','admin') ORDER BY role, fullname, email"
  ).all();
  const council = rows.map(r => ({
    id: r.id,
    email: r.email,
    fullname: r.fullname || r.email || '',
    role: r.role,
    roleDisplay: r.role === 'admin' ? 'Admin' : (r.role === 'chu_tich' ? 'Chủ tịch HĐKHCN' : r.role === 'thu_ky' ? 'Thư ký HĐKHCN' : 'Thành viên HĐKHCN')
  }));
  return res.json({ council });
});

// Bước quy trình Đề tài cấp Viện: Thư ký HĐKHCN — Bước 2 (Kiểm tra hồ sơ): Đánh dấu Hợp lệ / Yêu cầu bổ sung
app.post('/api/cap-vien/submissions/:id/steps/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const step = req.params.step;
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = dbCapVien.prepare('SELECT id, title, status, submittedBy FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isSecretaryOrAdmin = role === 'admin' || role === 'thu_ky';
  if (step === '2') {
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const currentStatus = sub.status || 'SUBMITTED';
    const roleLower = (role || '').toLowerCase();

    // Chỉ Admin mới được đưa hồ sơ về Bước 2 để kiểm tra lại
    if (action === 'revert') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'Chỉ Admin mới được đưa hồ sơ về Bước 2 (kiểm tra lại)' });
      }
      if (currentStatus === 'SUBMITTED') {
        return res.status(400).json({ message: 'Hồ sơ đang ở Bước 2, không cần đưa về' });
      }
      dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?')
        .run('SUBMITTED', id);
      insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin đưa hồ sơ về Bước 2 để kiểm tra lại');
      console.log('[API] cap-vien step 2 revert — submission ' + id);
      return res.json({ message: 'Đã đưa hồ sơ về Bước 2. Thư ký có thể nhấn Hợp lệ hoặc Yêu cầu bổ sung lại.', status: 'SUBMITTED' });
    }

    if (!isSecretaryOrAdmin) {
      return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới được thực hiện Bước 2 (Kiểm tra hồ sơ)' });
    }
    if (currentStatus !== 'SUBMITTED') {
      return res.status(400).json({ message: 'Hồ sơ này đã được xử lý tại Bước 2. Chỉ Admin mới có thể đưa về để kiểm tra lại.' });
    }
    if (action === 'approve') {
      const reviewedAt = new Date().toISOString();
      const note = (payload.note || '').trim();
      dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
        .run('VALIDATED', note, reviewedAt, req.user.id, id);
      insertCapVienStep2History(id, 'secretary_approve', req.user.id, req.user.role === 'admin' ? 'admin' : 'secretary', note || 'Hợp lệ');
      const row = dbCapVien.prepare('SELECT submittedBy, submittedById, createdAt FROM cap_vien_submissions WHERE id = ?').get(id);
      const u = row && row.submittedById ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.submittedById) : null;
      const hasSupplement = (dbCapVien.prepare('SELECT 1 FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound > 0 LIMIT 1').get(id) || null) != null;
      sendCapVienStep2ValidatedEmail({
        submissionTitle: sub.title,
        submittedByEmail: (row && row.submittedBy) || sub.submittedBy,
        submittedByName: u ? u.fullname : null,
        createdAt: row ? row.createdAt : null,
        status: 'VALIDATED',
        reviewedByName: req.user.fullname || req.user.email,
        hasSupplement
      });
      console.log('[API] cap-vien step 2 approve — submission ' + id);
      return res.json({ message: 'Đã Hợp lệ. Hồ sơ chuyển sang Bước 3.', status: 'VALIDATED' });
    }
    if (action === 'request_revision') {
      const note = (payload.note || '').trim();
      if (!note) return res.status(400).json({ message: 'Vui lòng nhập nội dung yêu cầu bổ sung' });
      const reviewedAt = new Date().toISOString();
      dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
        .run('NEED_REVISION', note, reviewedAt, req.user.id, id);
      insertCapVienStep2History(id, 'secretary_request_revision', req.user.id, req.user.role === 'admin' ? 'admin' : 'secretary', note);
      const secretaryName = (req.user.fullname || req.user.email || 'Thư ký').toString();
      const rowSub = dbCapVien.prepare('SELECT submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
      const researcherName = rowSub && rowSub.submittedById ? (db.prepare('SELECT fullname FROM users WHERE id = ?').get(rowSub.submittedById) || {}).fullname : null;
      sendCapVienStep2RevisionEmail(sub.title, sub.submittedBy || null, note, secretaryName, id, researcherName);
      console.log('[API] cap-vien step 2 request_revision — submission ' + id);
      return res.json({ message: 'Đã ghi nhận yêu cầu bổ sung. Nội dung đã gửi nghiên cứu viên và thông báo cho Hội đồng.', status: 'NEED_REVISION' });
    }
    return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng action: approve, request_revision hoặc revert (chỉ Admin)' });
  }
  if (step === '3') {
    const isChairmanOrAdmin = role === 'admin' || role === 'chu_tich';
    if (!isChairmanOrAdmin) {
      return res.status(403).json({ message: 'Chỉ Chủ tịch HĐKHCN hoặc Admin mới được phân công phản biện' });
    }
    if ((sub.status || '') !== 'VALIDATED') {
      return res.status(400).json({ message: 'Chỉ có thể phân công phản biện khi hồ sơ đã Hợp lệ (Bước 2 xong)' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    if (action !== 'assign') {
      return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng action: assign' });
    }
    let reviewerIds = (payload.reviewerIds || body.reviewerIds || []).map(rid => parseInt(rid, 10)).filter(rid => rid > 0);
    if (payload.reviewer1 && payload.reviewer2) {
      reviewerIds = [parseInt(payload.reviewer1, 10), parseInt(payload.reviewer2, 10)].filter(rid => rid > 0);
    }
    reviewerIds = [...new Set(reviewerIds)];
    if (reviewerIds.length < 2) {
      return res.status(400).json({ message: 'Vui lòng chọn đủ 2 phản biện từ danh sách thành viên Hội đồng' });
    }
    const councilIds = db.prepare("SELECT id FROM users WHERE role IN ('chu_tich','thu_ky','thanh_vien','admin')").all().map(r => r.id);
    const invalid = reviewerIds.filter(rid => !councilIds.includes(rid));
    if (invalid.length > 0) {
      return res.status(400).json({ message: 'Tất cả phản biện phải là thành viên Hội đồng (Chủ tịch, Thư ký, Thành viên HĐKHCN)' });
    }
    const assignedAt = new Date().toISOString();
    dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ?, assignedReviewerIds = ?, assignedAt = ?, assignedById = ? WHERE id = ?')
      .run('ASSIGNED', JSON.stringify(reviewerIds), assignedAt, req.user.id, id);
    const reviewerNamesArr = db.prepare('SELECT fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds).map(r => r.fullname || '');
    insertCapVienHistory(id, '3', 'chairman_assign', req.user.id, role === 'admin' ? 'admin' : 'chairman', 'Phân công 2 phản biện: ' + reviewerNamesArr.join(', '));
    const chairmanName = (req.user.fullname || req.user.email || 'Chủ tịch').toString();
    const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds);
    const reviewerEmails = reviewers.map(r => r.email);
    const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
    sendCapVienStep3AssignEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, id);
    sendCapVienStep4aNotifyBudgetTeamEmail({ submissionTitle: sub.title, submissionId: id });
    console.log('[API] cap-vien step 3 assign — submission ' + id + ', reviewers: ' + reviewerIds.join(','));
    return res.json({ message: 'Đã phân công phản biện. Email đã gửi đến các phản biện, Hội đồng và Tổ thẩm định tài chính.', status: 'ASSIGNED' });
  }
  return res.status(404).json({ message: 'Bước ' + step + ' chưa được triển khai tại backend' });
});

// Bước 4: Phản biện upload phiếu đánh giá (slot 1 hoặc 2) - upload KHONG tu dong "hoan thanh"
app.post('/api/cap-vien/submissions/:id/steps/4/reviewer-upload', authMiddleware, uploadCapVien.single('phieu_danh_gia'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt(req.body.slot || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoặc slot không hợp lệ (slot: 1 hoặc 2)' });
  const sub = dbCapVien.prepare('SELECT id, title, status, assignedReviewerIds, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ thao tác được ở Bước 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'Chỉ phản biện được phân công hoặc Admin mới được upload phiếu đánh giá' });
  const file = req.file || req.files?.phieu_danh_gia?.[0];
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file phiếu đánh giá (PDF hoặc Word)' });

  const firstExisting = dbCapVien.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  const oldFile = dbCapVien.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  dbCapVien.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, 'reviewer_phieu_' + slot);
  if (oldFile && oldFile.path && fs.existsSync(oldFile.path)) {
    try { fs.unlinkSync(oldFile.path); } catch (e) {}
  }

  const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
  const newPath = path.join(baseDir, 'reviewer_' + slot + '_' + Date.now() + path.extname(storedName || '.pdf'));
  try { fs.renameSync(file.path, newPath); } catch (e) { try { fs.copyFileSync(file.path, newPath); } catch (_) {} }
  dbCapVien.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound) VALUES (?, ?, ?, ?, 0)')
    .run(id, 'reviewer_phieu_' + slot, storedName, newPath);

  // Upload moi/ghi de thi phai nhan "Hoan thanh" lai
  dbCapVien.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 0, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
    .run('ASSIGNED', 'UNDER_REVIEW', id);

  insertCapVienHistory(id, '4', 'reviewer_upload', req.user.id, 'reviewer', 'Phản biện ' + slot + ' upload phiếu đánh giá');
  console.log('[API] cap-vien step 4 reviewer-upload slot ' + slot + ' — submission ' + id);
  return res.json({ message: 'Đã upload phiếu đánh giá. Vui lòng nhấn "Hoàn thành phản biện ' + slot + '" sau khi kiểm tra.', slot });
});

// Bước 4: Phản biện xác nhận hoàn thành slot
app.post('/api/cap-vien/submissions/:id/steps/4/reviewer-complete', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt((req.body && req.body.slot) || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoặc slot không hợp lệ (slot: 1 hoặc 2)' });
  const sub = dbCapVien.prepare('SELECT id, title, status, assignedReviewerIds, budget_4a_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ thao tác được ở Bước 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'Chỉ phản biện được phân công hoặc Admin mới được xác nhận hoàn thành' });

  const hasFile = dbCapVien.prepare('SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  if (!hasFile) return res.status(400).json({ message: 'Phản biện ' + slot + ' chưa upload file. Vui lòng upload trước khi nhấn hoàn thành.' });

  dbCapVien.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 1 WHERE id = ?').run(id);
  insertCapVienHistory(id, '4', 'reviewer_complete', req.user.id, 'reviewer', 'Phản biện ' + slot + ' xác nhận hoàn thành');

  const doneRow = dbCapVien.prepare('SELECT step_4_reviewer1_done, step_4_reviewer2_done, budget_4a_status FROM cap_vien_submissions WHERE id = ?').get(id);
  const bothDone = !!(doneRow && doneRow.step_4_reviewer1_done && doneRow.step_4_reviewer2_done);
  const budgetApproved = !!(doneRow && doneRow.budget_4a_status === 'approved');
  if (bothDone && budgetApproved) {
    dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('REVIEWED', id);
    sendCapVienStep5ReadyEmail({ submissionTitle: sub.title, submissionId: id });
  } else {
    dbCapVien.prepare('UPDATE cap_vien_submissions SET status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
      .run('ASSIGNED', 'UNDER_REVIEW', id);
  }

  return res.json({
    message: bothDone ? 'Đã ghi nhận: cả 2 phản biện đã hoàn thành.' : ('Đã ghi nhận: phản biện ' + slot + ' hoàn thành.'),
    slot,
    bothDone,
    step5Ready: bothDone && budgetApproved
  });
});

// Bước 4: Xóa file phản biện để upload lại
app.post('/api/cap-vien/submissions/:id/steps/4/reviewer-delete', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt((req.body && req.body.slot) || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoặc slot không hợp lệ (slot: 1 hoặc 2)' });
  const sub = dbCapVien.prepare('SELECT id, status, assignedReviewerIds FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ thao tác được ở Bước 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'Chỉ phản biện được phân công hoặc Admin mới được xóa file phản biện' });

  const row = dbCapVien.prepare('SELECT id, path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  if (!row) return res.status(400).json({ message: 'Chưa có file phản biện ' + slot + ' để xóa' });
  dbCapVien.prepare('DELETE FROM cap_vien_submission_files WHERE id = ?').run(row.id);
  if (row.path && fs.existsSync(row.path)) {
    try { fs.unlinkSync(row.path); } catch (e) {}
  }
  dbCapVien.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 0, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
    .run('REVIEWED', 'UNDER_REVIEW', id);
  insertCapVienHistory(id, '4', 'reviewer_delete', req.user.id, 'reviewer', 'Xóa file phản biện ' + slot + ' để upload lại');
  return res.json({ message: 'Đã xóa file phản biện ' + slot + '. Bạn có thể upload lại và nhấn hoàn thành.', slot });
});

// Bước 4A: Nộp phiếu thẩm định dự toán — upload 2 file (budget_phieu_tham_dinh, budget_to_trinh)
app.post('/api/cap-vien/submissions/:id/steps/4a/upload', authMiddleware, uploadCapVien.fields([
  { name: 'budget_phieu_tham_dinh', maxCount: 1 },
  { name: 'budget_to_trinh', maxCount: 1 }
]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = dbCapVien.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'].includes(role);
  if (!isCouncilOrAdmin) {
    return res.status(403).json({ message: 'Chỉ thành viên Hội đồng, Tổ thẩm định tài chính hoặc Admin mới được nộp phiếu thẩm định dự toán' });
  }
  const files = req.files || {};
  const f1 = files.budget_phieu_tham_dinh && files.budget_phieu_tham_dinh[0];
  const f2 = files.budget_to_trinh && files.budget_to_trinh[0];
  if (!f1 || !f2) {
    return res.status(400).json({ message: 'Vui lòng tải lên đủ 2 file: Phiếu thẩm định (SCI-BUDGET-01) và Tờ trình (SCI-BUDGET-02)' });
  }
  const firstExisting = dbCapVien.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const BUDGET_FIELDS = [
    { field: 'budget_phieu_tham_dinh', file: f1 },
    { field: 'budget_to_trinh', file: f2 }
  ];
  dbCapVien.transaction(() => {
    for (const { field, file } of BUDGET_FIELDS) {
      dbCapVien.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, field);
      const ext = path.extname(file.originalname) || '.pdf';
      const storedName = 'budget_' + field + '_' + Date.now() + ext;
      const newPath = path.join(baseDir, storedName);
      fs.renameSync(file.path, newPath);
      dbCapVien.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound) VALUES (?, ?, ?, ?, 0)')
        .run(id, field, file.originalname, newPath);
    }
  })();
  const roleLabel = role === 'totruong_tham_dinh_tc' ? 'totruong_tham_dinh' : (role === 'thanh_vien_tham_dinh_tc' ? 'thanh_vien_tham_dinh' : role);
  insertCapVienHistory(id, '4a', 'budget_upload', req.user.id, roleLabel, 'Nộp phiếu thẩm định dự toán: SCI-BUDGET-01, SCI-BUDGET-02');
  console.log('[API] cap-vien step 4a upload — submission ' + id);
  return res.json({ message: 'Đã nộp phiếu thẩm định dự toán. Thành viên Hội đồng có thể tải file ngay.', files: ['budget_phieu_tham_dinh', 'budget_to_trinh'] });
});

// Bước 4A: Tổ thẩm định yêu cầu bổ sung/chỉnh sửa dự toán — comment + file upload
app.post('/api/cap-vien/submissions/:id/steps/4a/request-revision', authMiddleware, uploadCapVien.fields([
  { name: 'revision_files', maxCount: 10 }
]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = dbCapVien.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isBudgetTeam = role === 'admin' || ['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'].includes(role);
  if (!isBudgetTeam) return res.status(403).json({ message: 'Chỉ Tổ thẩm định tài chính hoặc Admin mới được yêu cầu bổ sung dự toán' });
  const note = (req.body.note || req.body.comment || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lòng nhập nội dung yêu cầu bổ sung/chỉnh sửa' });
  const files = req.files || {};
  const fList = files.revision_files || [];
  const firstExisting = dbCapVien.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const ts = Date.now();
  let idx = 0;
  for (const f of fList) {
    if (!f || !f.path) continue;
    const storedName = fixFilenameEncoding(f.originalname) || path.basename(f.path);
    const newPath = path.join(baseDir, 'budget_revision_req_' + ts + '_' + idx + '_' + (storedName || '').replace(/[^a-zA-Z0-9._-]/g, '_'));
    try { fs.renameSync(f.path, newPath); } catch (e) { try { fs.copyFileSync(f.path, newPath); } catch (_) {} }
    dbCapVien.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound) VALUES (?, ?, ?, ?, 0)')
      .run(id, 'budget_revision_request_' + ts + '_' + idx, storedName, newPath);
    idx++;
  }
  const requestedAt = new Date().toISOString();
  dbCapVien.prepare('UPDATE cap_vien_submissions SET budget_4a_status = ?, budget_4a_revision_note = ?, budget_4a_revision_requested_at = ?, budget_4a_revision_requested_by = ? WHERE id = ?')
    .run('need_revision', note, requestedAt, req.user.id, id);
  insertCapVienHistory(id, '4a', 'budget_request_revision', req.user.id, role === 'admin' ? 'admin' : 'totruong_tham_dinh', note);
  const researcher = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById);
  const councilList = getNotificationEmails();
  sendCapVienBudgetRevisionRequestEmail({ submissionTitle: sub.title, researcherEmail: researcher ? researcher.email : null, researcherName: researcher ? researcher.fullname : null, note, requestedByName: req.user.fullname || req.user.email, submissionId: id, councilList });
  console.log('[API] cap-vien step 4a request-revision — submission ' + id);
  return res.json({ message: 'Đã gửi yêu cầu bổ sung. Email đã gửi đến Chủ nhiệm và CC Hội đồng.', status: 'need_revision' });
});

// Bước 4A: Nghiên cứu viên (Chủ nhiệm) nộp lại tài liệu tài chính đã chỉnh sửa
app.post('/api/cap-vien/submissions/:id/steps/4a/upload-revised', authMiddleware, uploadCapVien.fields([
  { name: 'budget_phieu_tham_dinh', maxCount: 1 },
  { name: 'budget_to_trinh', maxCount: 1 }
]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = dbCapVien.prepare('SELECT id, title, status, submittedById, budget_4a_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.budget_4a_status || '') !== 'need_revision') {
    return res.status(400).json({ message: 'Chỉ được nộp tài liệu chỉnh sửa khi Tổ thẩm định đã yêu cầu bổ sung (Bước 4A)' });
  }
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được nộp tài liệu chỉnh sửa' });
  const files = req.files || {};
  const f1 = files.budget_phieu_tham_dinh && files.budget_phieu_tham_dinh[0];
  const f2 = files.budget_to_trinh && files.budget_to_trinh[0];
  if (!f1 || !f2) return res.status(400).json({ message: 'Vui lòng tải lên đủ 2 file: Phiếu thẩm định (SCI-BUDGET-01) và Tờ trình (SCI-BUDGET-02)' });
  const firstExisting = dbCapVien.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const BUDGET_FIELDS = [
    { field: 'budget_phieu_tham_dinh', file: f1 },
    { field: 'budget_to_trinh', file: f2 }
  ];
  dbCapVien.transaction(() => {
    for (const { field, file } of BUDGET_FIELDS) {
      dbCapVien.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, field);
      const ext = path.extname(file.originalname) || '.pdf';
      const storedName = 'budget_revised_' + field + '_' + Date.now() + ext;
      const newPath = path.join(baseDir, storedName);
      fs.renameSync(file.path, newPath);
      dbCapVien.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound) VALUES (?, ?, ?, ?, 0)')
        .run(id, field, file.originalname, newPath);
    }
  })();
  dbCapVien.prepare('UPDATE cap_vien_submissions SET budget_4a_status = ?, budget_4a_revision_note = NULL, budget_4a_revision_requested_at = NULL, budget_4a_revision_requested_by = NULL WHERE id = ?')
    .run(null, id);
  insertCapVienHistory(id, '4a', 'researcher_upload_revised', req.user.id, 'researcher', 'Nghiên cứu viên nộp tài liệu tài chính đã chỉnh sửa');
  const councilList = getNotificationEmails();
  sendCapVienBudgetRevisedSubmittedEmail({ submissionTitle: sub.title, researcherName: req.user.fullname || req.user.email, submissionId: id, councilList });
  console.log('[API] cap-vien step 4a upload-revised — submission ' + id);
  return res.json({ message: 'Đã nộp tài liệu chỉnh sửa. Tổ thẩm định sẽ kiểm tra và phê duyệt hoặc yêu cầu bổ sung tiếp.' });
});

// Bước 4A: Tổ thẩm định phê duyệt dự toán
app.post('/api/cap-vien/submissions/:id/steps/4a/approve', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = dbCapVien.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isBudgetTeam = role === 'admin' || ['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'].includes(role);
  if (!isBudgetTeam) return res.status(403).json({ message: 'Chỉ Tổ thẩm định tài chính hoặc Admin mới được phê duyệt dự toán' });
  const approvedAt = new Date().toISOString();
  dbCapVien.prepare('UPDATE cap_vien_submissions SET budget_4a_status = ?, budget_4a_approved_at = ?, budget_4a_approved_by = ? WHERE id = ?')
    .run('approved', approvedAt, req.user.id, id);
  insertCapVienHistory(id, '4a', 'budget_approve', req.user.id, role === 'admin' ? 'admin' : 'totruong_tham_dinh', 'Tổ thẩm định phê duyệt dự toán');
  const researcher = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById);
  const councilList = getNotificationEmails();
  sendCapVienBudgetApprovedEmail({ submissionTitle: sub.title, researcherEmail: researcher ? researcher.email : null, researcherName: researcher ? researcher.fullname : null, approvedByName: req.user.fullname || req.user.email, submissionId: id, councilList });
  const step4Done = (() => {
    const r = dbCapVien.prepare('SELECT step_4_reviewer1_done, step_4_reviewer2_done FROM cap_vien_submissions WHERE id = ?').get(id);
    return r && r.step_4_reviewer1_done && r.step_4_reviewer2_done;
  })();
  if (step4Done) {
    dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('REVIEWED', id);
    sendCapVienStep5ReadyEmail({ submissionTitle: sub.title, submissionId: id });
  }
  console.log('[API] cap-vien step 4a approve — submission ' + id);
  return res.json({ message: 'Đã phê duyệt dự toán. Email đã gửi đến Chủ nhiệm và Hội đồng.' + (step4Done ? ' Bước 4 và 4A đều hoàn thành, đã chuyển sang Bước 5.' : ' Đang chờ Bước 4 (Phản biện) hoàn thành.'), status: 'approved', step5Ready: step4Done });
});

// Admin: Gửi lại email Bước 4 (phân công phản biện → phản biện + Hội đồng) — dùng khi đã qua bước 3→4 nhưng email chưa gửi
app.post('/api/cap-vien/submissions/:id/send-step4-email', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = dbCapVien.prepare('SELECT id, title, status, assignedReviewerIds, assignedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ gửi được email Bước 4 khi hồ sơ đã qua Bước 3 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  if (reviewerIds.length < 2) return res.status(400).json({ message: 'Hồ sơ chưa có đủ 2 phản biện được phân công' });
  const chairmanRow = sub.assignedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(sub.assignedById) : null;
  const chairmanName = (chairmanRow && (chairmanRow.fullname || chairmanRow.email)) || 'Chủ tịch';
  const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds);
  const reviewerEmails = reviewers.map(r => r.email).filter(Boolean);
  const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
  sendCapVienStep3AssignEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, id);
  console.log('[API] cap-vien admin send-step4-email — submission ' + id);
  return res.json({ message: 'Đã gửi email Bước 4 đến các phản biện và Hội đồng.' });
});

// Admin: Gửi lại email Bước 4A (thông báo Tổ thẩm định tài chính, CC Hội đồng) — dùng khi đã qua bước 3→4 nhưng email chưa gửi
app.post('/api/cap-vien/submissions/:id/send-step4a-email', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = dbCapVien.prepare('SELECT id, title, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ gửi được email Bước 4A khi hồ sơ đã qua Bước 3 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  sendCapVienStep4aNotifyBudgetTeamEmail({ submissionTitle: sub.title, submissionId: id });
  console.log('[API] cap-vien admin send-step4a-email — submission ' + id);
  return res.json({ message: 'Đã gửi email Bước 4A đến Tổ thẩm định tài chính (CC Hội đồng).' });
});

// Admin đưa hồ sơ về Bước 2 (route riêng để đảm bảo revert luôn hoạt động)
app.post('/api/cap-vien/submissions/:id/revert-to-step-2', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const roleLower = (req.user.role || '').toLowerCase();
  if (roleLower !== 'admin') {
    return res.status(403).json({ message: 'Chỉ Admin mới được đưa hồ sơ về Bước 2 (kiểm tra lại)' });
  }
  const sub = dbCapVien.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const currentStatus = sub.status || 'SUBMITTED';
  if (currentStatus === 'SUBMITTED') {
    return res.status(400).json({ message: 'Hồ sơ đang ở Bước 2, không cần đưa về' });
  }
  dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?')
    .run('SUBMITTED', id);
  insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin đưa hồ sơ về Bước 2 để kiểm tra lại');
  console.log('[API] cap-vien revert-to-step-2 — submission ' + id);
  return res.json({ message: 'Đã đưa hồ sơ về Bước 2. Thư ký có thể nhấn Hợp lệ hoặc Yêu cầu bổ sung lại.', status: 'SUBMITTED' });
});

// Admin đưa hồ sơ về bước trước (3, 4, 5, 6, 7) — nút "Đưa về Bước N (Admin)"
app.post('/api/cap-vien/submissions/:id/revert-to-step/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const step = parseInt(req.params.step, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  if (isNaN(step) || step < 2 || step > 7) return res.status(400).json({ message: 'Bước phải từ 2 đến 7' });
  const roleLower = (req.user.role || '').toLowerCase();
  if (roleLower !== 'admin') {
    return res.status(403).json({ message: 'Chỉ Admin mới được đưa hồ sơ về bước trước đó' });
  }
  const sub = dbCapVien.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });

  if (step === 2) {
    dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?').run('SUBMITTED', id);
    insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin đưa hồ sơ về Bước 2');
    return res.json({ message: 'Đã đưa hồ sơ về Bước 2.', status: 'SUBMITTED' });
  }

  const clearStep4And4a = () => {
    dbCapVien.prepare('UPDATE cap_vien_submissions SET step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, budget_4a_status = NULL, budget_4a_revision_note = NULL, budget_4a_revision_requested_at = NULL, budget_4a_revision_requested_by = NULL, budget_4a_approved_at = NULL, budget_4a_approved_by = NULL WHERE id = ?').run(id);
  };

  if (step === 3) {
    dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('VALIDATED', id);
    clearStep4And4a();
    console.log('[API] cap-vien revert-to-step 3 — submission ' + id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 3 (Phân công phản biện).', status: 'VALIDATED' });
  }

  if (step === 4) {
    dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('ASSIGNED', id);
    clearStep4And4a();
    console.log('[API] cap-vien revert-to-step 4 — submission ' + id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 4 & 4A.', status: 'ASSIGNED' });
  }

  if (step === 5) {
    dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('REVIEWED', id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 5 (Họp Hội đồng).', status: 'REVIEWED' });
  }

  if (step === 6) {
    dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONDITIONAL', id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 6 (Cấp Quyết định).', status: 'CONDITIONAL' });
  }

  if (step === 7) {
    dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('APPROVED', id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 7 (Ký hợp đồng).', status: 'APPROVED' });
  }

  return res.status(400).json({ message: 'Bước không hợp lệ' });
});

// Nghiên cứu viên nộp lại hồ sơ sau khi Thư ký yêu cầu bổ sung (Bước 2) — chỉ cập nhật trạng thái (không file). Nếu có file bổ sung thì dùng POST /supplement.
app.post('/api/cap-vien/submissions/:id/resubmit', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = dbCapVien.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'NEED_REVISION') {
    return res.status(400).json({ message: 'Chỉ được nộp lại khi Thư ký đã yêu cầu bổ sung (trạng thái Cần bổ sung)' });
  }
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ chủ nhiệm đề tài hoặc Admin mới được nộp lại hồ sơ' });
  }
  dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('SUBMITTED', id);
  insertCapVienStep2History(id, 'researcher_resubmit', req.user.id, 'researcher', 'Nghiên cứu viên nộp lại hồ sơ (không file bổ sung)');
  console.log('[API] cap-vien resubmit — submission ' + id);
  return res.json({ message: 'Đã ghi nhận nộp lại hồ sơ. Thư ký sẽ kiểm tra và nhấn Hợp lệ hoặc Yêu cầu bổ sung.', status: 'SUBMITTED' });
});

// Nộp hồ sơ bổ sung (Bước 2 — vẫn trong quy trình Bước 2): upload file(s), lưu bên dưới hồ sơ gốc (revisionRound tăng), chuyển status về SUBMITTED
app.post('/api/cap-vien/submissions/:id/supplement', authMiddleware, (req, res, next) => {
  uploadCapVien.array('supplement', 20)(req, res, (err) => {
    if (err) {
      req.files = [];
      req._uploadDirCapVien = null;
    }
    next();
  });
}, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = dbCapVien.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'NEED_REVISION') {
    return res.status(400).json({ message: 'Chỉ được nộp hồ sơ bổ sung khi Thư ký đã yêu cầu bổ sung (trạng thái Cần bổ sung)' });
  }
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ chủ nhiệm đề tài hoặc Admin mới được nộp hồ sơ bổ sung' });
  }
  const uploadedFiles = req.files && Array.isArray(req.files) ? req.files : [];
  const nextRound = (dbCapVien.prepare('SELECT COALESCE(MAX(revisionRound), 0) + 1 AS r FROM cap_vien_submission_files WHERE submissionId = ?').get(id) || {}).r || 1;
  let submissionDir = null;
  const firstExisting = dbCapVien.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  if (firstExisting && firstExisting.path) submissionDir = path.dirname(firstExisting.path);
  if (!submissionDir && uploadedFiles.length > 0) {
    const researcherFolder = sanitizeFolderName(req.user.fullname) || sanitizeFolderName(req.user.email.split('@')[0]) + '_' + req.user.id;
    submissionDir = path.join(uploadDirCapVien, researcherFolder, 'submission_' + id);
    fs.mkdirSync(submissionDir, { recursive: true });
  }
  const move = (f, index) => {
    if (!f || !f.path) return;
    const storedName = fixFilenameEncoding(f.originalname) || path.basename(f.path);
    const newPath = path.join(submissionDir, 'supplement_' + nextRound + '_' + index + '_' + (storedName || '').replace(/[^a-zA-Z0-9._-]/g, '_'));
    try { fs.renameSync(f.path, newPath); } catch (e) { try { fs.copyFileSync(f.path, newPath); } catch (_) {} }
    dbCapVien.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'supplement_' + index, storedName, newPath, nextRound);
  };
  uploadedFiles.forEach((f, i) => move(f, i));
  const tempDir = req._uploadDirCapVien;
  if (tempDir && fs.existsSync(tempDir)) { try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {} }
  dbCapVien.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('SUBMITTED', id);
  insertCapVienStep2History(id, 'researcher_supplement', req.user.id, 'researcher', uploadedFiles.length > 0 ? `Nộp hồ sơ bổ sung lần ${nextRound} (${uploadedFiles.length} file)` : 'Nộp hồ sơ bổ sung');
  const row = dbCapVien.prepare('SELECT submittedBy, submittedById, createdAt FROM cap_vien_submissions WHERE id = ?').get(id);
  const u = row && row.submittedById ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.submittedById) : null;
  sendCapVienSupplementSubmittedEmail({
    submissionTitle: sub.title,
    submittedByEmail: (row && row.submittedBy) || null,
    submittedByName: u ? u.fullname : null,
    createdAt: row ? row.createdAt : null,
    status: 'SUBMITTED',
    supplementRound: nextRound
  });
  console.log('[API] cap-vien supplement — submission ' + id + ', round ' + nextRound + ', files: ' + uploadedFiles.length);
  return res.json({
    message: uploadedFiles.length > 0
      ? 'Đã ghi nhận hồ sơ bổ sung (lần ' + nextRound + '). Quá trình vẫn ở Bước 2. Thư ký sẽ kiểm tra và nhấn Hợp lệ hoặc Yêu cầu bổ sung.'
      : 'Đã ghi nhận. Thư ký sẽ kiểm tra và nhấn Hợp lệ hoặc Yêu cầu bổ sung.',
    status: 'SUBMITTED',
    supplementRound: nextRound,
    filesCount: uploadedFiles.length
  });
});

app.get('/api/cap-vien/submissions/:id/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = dbCapVien.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền tải hồ sơ này' });
  }
  const files = dbCapVien.prepare('SELECT path, originalName FROM cap_vien_submission_files WHERE submissionId = ?').all(id);
  if (files.length === 0) return res.status(404).json({ message: 'Không tìm thấy file hồ sơ' });
  if (files.length === 1) return res.download(files[0].path, files[0].originalName);
  try {
    const archiver = require('archiver');
    res.attachment('ho-so-cap-vien-' + id + '.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    files.forEach(f => archive.file(f.path, { name: f.originalName }));
    archive.finalize();
  } catch (e) {
    res.download(files[0].path, files[0].originalName);
  }
});

app.get('/api/cap-vien/submissions/:id/files/:fileId/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const sub = dbCapVien.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) return res.status(403).json({ message: 'Bạn không có quyền tải file này' });
  const file = dbCapVien.prepare('SELECT id, path, originalName FROM cap_vien_submission_files WHERE id = ? AND submissionId = ?').get(fileId, id);
  if (!file || !file.path) return res.status(404).json({ message: 'Không tìm thấy file' });
  if (!fs.existsSync(file.path)) return res.status(404).json({ message: 'File không tồn tại trên đĩa' });
  res.download(file.path, file.originalName);
});

app.delete('/api/cap-vien/submissions/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = dbCapVien.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const files = dbCapVien.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ?').all(id);
  const submissionDir = files.length > 0 ? path.dirname(files[0].path) : null;
  dbCapVien.transaction(() => {
    dbCapVien.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ?').run(id);
    dbCapVien.prepare('DELETE FROM cap_vien_submissions WHERE id = ?').run(id);
  })();
  if (submissionDir && fs.existsSync(submissionDir)) {
    try { fs.rmSync(submissionDir, { recursive: true }); } catch (e) { /* ignore */ }
  }
  return res.json({ message: 'Đã xóa hồ sơ đề tài cấp Viện' });
});

// Admin: danh sách user
app.get('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT id, email, fullname, role, academicTitle, createdAt FROM users ORDER BY createdAt DESC').all();
  return res.json({ users: rows });
});

// Admin: thêm tài khoản mới hoặc cập nhật họ tên + vai trò (gõ họ tên, email, chọn vai trò)
app.post('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
  const { email, fullname, role, password, academicTitle } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lòng nhập email' });
  const allowed = ['researcher', 'thanh_vien', 'thu_ky', 'chu_tich', 'admin', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
  const r = (role || 'researcher').toLowerCase().trim();
  if (!allowed.includes(r)) return res.status(400).json({ message: 'Vai trò không hợp lệ. Vui lòng khởi động lại server (node server.js) và thử lại.' });
  const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
  if (councilRoles.includes(r) && !em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'Chỉ email @sci.edu.vn mới được gán vai trò Chủ tịch, Thư ký, Thành viên Hội đồng' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  const acadTitle = (academicTitle || '').trim() || null;
  if (existing) {
    db.prepare('UPDATE users SET fullname = ?, role = ?, academicTitle = ? WHERE email = ?').run((fullname || '').trim(), r, acadTitle, em);
    return res.json({ message: 'Đã cập nhật họ tên và vai trò cho ' + em });
  }
  const plainPassword = (password || '').trim();
  const finalPassword = plainPassword.length >= 6 ? plainPassword : crypto.randomBytes(8).toString('hex');
  const hash = await bcrypt.hash(finalPassword, 10);
  db.prepare('INSERT INTO users (email, password, fullname, role, academicTitle) VALUES (?, ?, ?, ?, ?)').run(em, hash, (fullname || '').trim(), r, acadTitle);
  if (plainPassword.length < 6) {
    return res.status(201).json({ message: 'Đã thêm tài khoản. Mật khẩu tạm (gửi cho thành viên): ' + finalPassword, tempPassword: finalPassword });
  }
  return res.status(201).json({ message: 'Đã thêm tài khoản với mật khẩu do bạn đặt.' });
});

// Admin: gửi email thông báo cấp vai trò tới địa chỉ email
app.post('/api/admin/users/send-role-email', authMiddleware, adminOnly, async (req, res) => {
  const { email, fullname, role, tempPassword } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lòng nhập email' });
  const roleLabel = ROLE_LABELS[role] || role;
  let fullnameToUse = (fullname || '').trim();
  if (!fullnameToUse) {
    const row = db.prepare('SELECT fullname FROM users WHERE email = ?').get(em);
    if (row && row.fullname) fullnameToUse = row.fullname;
  }
  await sendRoleAssignmentEmail(em, fullnameToUse, role || 'researcher', tempPassword || null);
  if (!transporter) {
    return res.status(503).json({ message: 'Chưa cấu hình SMTP. Không thể gửi email. Xem README_BACKEND.md.' });
  }
  return res.json({ message: 'Đã gửi email thông báo đến ' + em });
});

// Admin: danh sách người nhận email thông báo (Admin thêm/xóa; khi có danh sách này thì mọi thông báo gửi tới đây)
app.get('/api/admin/notification-recipients', authMiddleware, adminOnly, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, email, fullname, createdAt FROM notification_recipients ORDER BY id').all();
    return res.json({ recipients: rows || [] });
  } catch (e) {
    return res.json({ recipients: [] });
  }
});

// ========== Thống kê trang chủ (số liệu thật từ các module) ==========
app.get('/api/homepage-stats', (req, res) => {
  syncMissionsFromCapVien();
  const missions = (db.prepare('SELECT COUNT(*) as c FROM missions').get() || {}).c || 0;
  const personnel = (db.prepare('SELECT COUNT(*) as c FROM personnel').get() || {}).c || 0;
  const ip = (db.prepare('SELECT COUNT(*) as c FROM ip_assets').get() || {}).c || 0;
  const publications = (db.prepare('SELECT COUNT(*) as c FROM publications').get() || {}).c || 0;
  const cooperation = (db.prepare('SELECT COUNT(*) as c FROM cooperation').get() || {}).c || 0;
  return res.json({ missions, personnel, ip, publications, cooperation });
});

// ========== Nhiệm vụ KHCN (Dashboard): trích xuất thống kê + danh sách tìm kiếm ==========
syncMissionsFromCapVien();

app.get('/api/missions/stats', (req, res) => {
  syncMissionsFromCapVien();
  const all = db.prepare('SELECT id, level, status, end_date, budget, start_date FROM missions').all();
  const now = new Date().toISOString().slice(0, 10);
  const thisMonthStart = now.slice(0, 7) + '-01';
  const byLevel = { national: 0, ministry: 0, university: 0, institute: 0 };
  const byStatus = { planning: 0, approved: 0, ongoing: 0, review: 0, completed: 0, overdue: 0, cho_phe_duyet_ngoai: 0, da_phe_duyet: 0, dang_thuc_hien: 0, nghiem_thu_trung_gian: 0, nghiem_thu_tong_ket: 0, hoan_thanh: 0, khong_duoc_phe_duyet: 0, cho_vien_xet_chon: 0, cho_bo_tham_dinh: 0, cho_ngoai_xet_chon: 0, cho_ky_hop_dong: 0, xin_dieu_chinh: 0, cho_nghiem_thu_co_so: 0, cho_nghiem_thu_bo_nn: 0, hoan_thien_sau_nghiem_thu: 0, thanh_ly_hop_dong: 0 };
  let totalBudget = 0;
  let overdue = 0;
  let completed = 0;
  let totalEnded = 0;
  let acceptanceThisMonth = 0;
  for (const m of all) {
    const lev = (m.level || 'institute').toLowerCase();
    if (byLevel[lev] !== undefined) byLevel[lev]++;
    const st = (m.status || 'planning').toLowerCase();
    if (byStatus[st] !== undefined) byStatus[st]++;
    if (m.budget != null) totalBudget += Number(m.budget);
    const isCompleted = ['completed', 'hoan_thanh'].includes(st);
    if (m.end_date && m.end_date < now && !isCompleted) overdue++;
    if (isCompleted) { completed++; totalEnded++; }
    else if (m.end_date) totalEnded++;
    if (['review', 'nghiem_thu_trung_gian', 'nghiem_thu_tong_ket', 'cho_nghiem_thu_co_so', 'cho_nghiem_thu_bo_nn', 'hoan_thien_sau_nghiem_thu'].includes(st)) acceptanceThisMonth++;
  }
  const completionRate = totalEnded > 0 ? Math.round((completed / totalEnded) * 100) : 0;
  return res.json({
    total: all.length,
    byLevel,
    byStatus,
    totalBudget: Math.round(totalBudget),
    overdue,
    completionRate,
    acceptanceThisMonth,
    totalOngoing: (byStatus.ongoing || 0) + (byStatus.dang_thuc_hien || 0)
  });
});

app.get('/api/missions', (req, res) => {
  syncMissionsFromCapVien();
  const q = (req.query.q || req.query.search || '').trim().toLowerCase();
  const level = (req.query.level || '').trim().toLowerCase();
  const status = (req.query.status || '').trim().toLowerCase();
  const year = (req.query.year || '').trim();
  let sql = 'SELECT id, code, title, principal, principal_hoc_vi, principal_don_vi, principal_orcid, level, status, start_date, end_date, progress, budget, source_id, source_type FROM missions WHERE 1=1';
  const params = [];
  if (level) { sql += ' AND level = ?'; params.push(level); }
  if (status) {
    const statusList = status.split(',').map(s => s.trim()).filter(Boolean);
    if (statusList.length === 1) { sql += ' AND status = ?'; params.push(statusList[0]); }
    else if (statusList.length > 1) { sql += ' AND status IN (' + statusList.map(() => '?').join(',') + ')'; params.push(...statusList); }
  }
  if (year) { sql += ' AND (start_date LIKE ? OR end_date LIKE ?)'; params.push(year + '%', year + '%'); }
  sql += ' ORDER BY start_date DESC, id DESC';
  let rows;
  try {
    rows = params.length ? db.prepare(sql).all(...params) : db.prepare(sql).all();
  } catch (e) {
    sql = sql.replace('principal_hoc_vi, principal_don_vi, principal_orcid, ', '');
    rows = params.length ? db.prepare(sql).all(...params) : db.prepare(sql).all();
    rows.forEach(r => { r.principal_hoc_vi = r.principal_don_vi = r.principal_orcid = null; });
  }
  if (q) {
    rows = rows.filter(r => {
      const code = (r.code || '').toLowerCase();
      const title = (r.title || '').toLowerCase();
      const principal = (r.principal || '').toLowerCase();
      return code.includes(q) || title.includes(q) || principal.includes(q);
    });
  }
  return res.json({ missions: rows });
});

// Tạo nhiệm vụ mới (Luồng B - Cấp Bộ/ĐHQG/Nhà nước). Cấp Viện dùng nop-de-tai-cap-vien.html
app.post('/api/missions', authMiddleware, (req, res) => {
  const user = req.user;
  const body = req.body || {};
  const level = (body.level || '').trim().toLowerCase();
  if (!['national', 'ministry', 'university'].includes(level)) {
    return res.status(400).json({ message: 'API này chỉ dùng cho Cấp Bộ, Cấp ĐHQG, Cấp Nhà nước. Cấp Viện vui lòng nộp tại trang Đề tài cấp Viện.' });
  }
  const title = (body.title || '').trim();
  if (!title) return res.status(400).json({ message: 'Tên đề tài không được để trống.' });
  const code = (body.code || '').trim() || ('DT-' + level.toUpperCase().slice(0, 2) + '-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-4));
  const principal = (user.fullname || user.email || '').trim() || null;
  const status = (body.status || 'cho_phe_duyet_ngoai').trim();
  const validStatus = ['cho_phe_duyet_ngoai', 'da_phe_duyet', 'dang_thuc_hien', 'nghiem_thu_trung_gian', 'nghiem_thu_tong_ket', 'hoan_thanh', 'khong_duoc_phe_duyet', 'planning', 'approved', 'ongoing', 'review', 'completed', 'overdue', 'cho_vien_xet_chon', 'cho_bo_tham_dinh', 'cho_ngoai_xet_chon', 'cho_ky_hop_dong', 'xin_dieu_chinh', 'cho_nghiem_thu_co_so', 'cho_nghiem_thu_bo_nn', 'hoan_thien_sau_nghiem_thu', 'thanh_ly_hop_dong'];
  const finalStatus = validStatus.includes(status) ? status : 'cho_vien_xet_chon';
  const startDate = (body.start_date || '').trim() || null;
  const endDate = (body.end_date || '').trim() || null;
  const progress = body.progress != null && !isNaN(parseInt(body.progress, 10)) ? Math.min(100, Math.max(0, parseInt(body.progress, 10))) : 0;
  const budget = body.budget != null && !isNaN(parseFloat(body.budget)) ? parseFloat(body.budget) : null;
  const managingAgency = (body.managing_agency || '').trim() || null;
  const contractNumber = (body.contract_number || '').trim() || null;
  const fundingSource = (body.funding_source || '').trim() || null;
  const approvedBudget = body.approved_budget != null && !isNaN(parseFloat(body.approved_budget)) ? parseFloat(body.approved_budget) : null;
  const disbursedBudget = body.disbursed_budget != null && !isNaN(parseFloat(body.disbursed_budget)) ? parseFloat(body.disbursed_budget) : null;
  const disbursementYear = (body.disbursement_year || '').trim() || null;
  const cooperatingUnits = (body.cooperating_units || '').trim() || null;
  const missionType = (body.mission_type || '').trim() || null;
  const field = (body.field || '').trim() || null;
  const objectives = (body.objectives || '').trim() || null;
  try {
    db.prepare(`
      INSERT INTO missions (code, title, principal, level, status, start_date, end_date, progress, budget, source_type,
        managing_agency, contract_number, funding_source, approved_budget, disbursed_budget, disbursement_year,
        cooperating_units, mission_type, field, objectives)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(code, title, principal, level, finalStatus, startDate, endDate, progress, budget,
      managingAgency, contractNumber, fundingSource, approvedBudget, disbursedBudget, disbursementYear,
      cooperatingUnits, missionType, field, objectives);
    const row = db.prepare('SELECT id, code, title, principal, level, status, managing_agency, objectives, start_date, end_date, budget, created_at FROM missions WHERE code = ? ORDER BY id DESC LIMIT 1').get(code);
    sendMissionProposalToCouncil(row, user.email || '');
    return res.status(201).json({ message: 'Đã đăng ký đề tài.', mission: row });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ message: 'Mã đề tài đã tồn tại.' });
    throw e;
  }
});

const LEVEL_LABELS_EMAIL = { national: 'Cấp Nhà nước', ministry: 'Cấp Bộ', university: 'Cấp ĐHQG', institute: 'Cấp Viện' };

function sendMissionProposalToCouncil(mission, submitterEmail) {
  const toList = getNotificationEmails();
  if (!transporter || toList.length === 0) {
    if (!transporter) console.log('[Email] Bỏ qua: chưa cấu hình SMTP');
    else console.log('[Email] Bỏ qua: chưa có người nhận (Quản trị → Danh sách người nhận email)');
    return Promise.resolve();
  }
  const missionId = mission.id;
  const title = mission.title || '';
  const principal = mission.principal || submitterEmail;
  const levelLabel = LEVEL_LABELS_EMAIL[mission.level] || mission.level || '';
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + missionId;
  const subject = '[Đề tài ngoài Viện] Đề xuất mới: ' + title;

  const detailLines = [];
  detailLines.push('- Chủ nhiệm: ' + principal);
  detailLines.push('- Cấp đề tài: ' + levelLabel);
  detailLines.push('- Tên đề tài: ' + title);
  if (mission.managing_agency) detailLines.push('- Cơ quan quản lý: ' + mission.managing_agency);
  if (mission.start_date || mission.end_date) detailLines.push('- Thời gian: ' + (mission.start_date || '—') + ' đến ' + (mission.end_date || '—'));
  if (mission.budget != null) detailLines.push('- Kinh phí dự kiến: ' + new Intl.NumberFormat('vi-VN').format(mission.budget) + ' VNĐ');
  if (mission.objectives) detailLines.push('- Mục tiêu nghiên cứu: ' + (mission.objectives.length > 200 ? mission.objectives.slice(0, 200) + '...' : mission.objectives));
  const detailBlock = detailLines.join('\n');

  const text =
    'Kính gửi các thầy cô thành viên Hội đồng KHCN Viện Tế bào gốc,\n\n' +
    'Chủ nhiệm ' + principal + ' vừa gửi đề xuất đề tài ' + levelLabel + ': ' + title + '.\n\n' +
    'Chi tiết đề tài:\n' + detailBlock + '\n\n' +
    'Vui lòng đăng nhập hệ thống để xem chi tiết và hồ sơ đính kèm, đồng thời thực hiện bước tiếp theo (xét chọn/phê duyệt đề xuất).\n\n' +
    'Xem tiến trình đề tài: ' + timelineUrl;

  const detailHtml = '<ul style="margin:10px 0;padding-left:20px;line-height:1.6">' +
    '<li><strong>Chủ nhiệm:</strong> ' + (principal || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>' +
    '<li><strong>Cấp đề tài:</strong> ' + (levelLabel || '').replace(/</g, '&lt;') + '</li>' +
    '<li><strong>Tên đề tài:</strong> ' + (title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>' +
    (mission.managing_agency ? '<li><strong>Cơ quan quản lý:</strong> ' + String(mission.managing_agency).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>' : '') +
    ((mission.start_date || mission.end_date) ? '<li><strong>Thời gian:</strong> ' + (mission.start_date || '—') + ' đến ' + (mission.end_date || '—') + '</li>' : '') +
    (mission.budget != null ? '<li><strong>Kinh phí dự kiến:</strong> ' + new Intl.NumberFormat('vi-VN').format(mission.budget) + ' VNĐ</li>' : '') +
    (mission.objectives ? '<li><strong>Mục tiêu nghiên cứu:</strong> ' + String(mission.objectives).slice(0, 300).replace(/</g, '&lt;').replace(/>/g, '&gt;') + (mission.objectives.length > 300 ? '...' : '') + '</li>' : '') +
    '</ul>';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>Kính gửi các thầy cô thành viên Hội đồng KHCN Viện Tế bào gốc,</p>' +
    '<p>Chủ nhiệm <strong>' + (principal || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> vừa gửi đề xuất đề tài <strong>' + (levelLabel || '').replace(/</g, '&lt;') + '</strong>: <strong>' + (title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong>.</p>' +
    '<p>Chi tiết đề tài:</p>' + detailHtml +
    '<p>Vui lòng đăng nhập hệ thống để xem chi tiết và hồ sơ đính kèm, đồng thời thực hiện bước tiếp theo (xét chọn/phê duyệt đề xuất).</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0;font-weight:600">Xem tiến trình đề tài</a></p>' +
    '</div>';

  console.log('[Email] Gửi thông báo đề xuất đề tài tới: ' + toList.join(', '));
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toList.join(', '),
    subject,
    text,
    html
  }).catch(err => console.error('[Email] Lỗi gửi:', err.message));
}

// Danh sách file đăng ký (Thuyết minh, Văn bản xin phép)
app.get('/api/missions/:id/files', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const rows = db.prepare('SELECT id, field_name, original_name, path, created_at FROM missions_files WHERE mission_id = ? ORDER BY created_at ASC').all(id);
  return res.json({ files: rows });
});

// Thông tin CN + nhiệm vụ đang thực hiện + cảnh báo Điều 10 (cho trang CT HĐ xét duyệt)
app.get('/api/missions/:id/cn-info', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  let mission = db.prepare('SELECT id, principal, level FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  try {
    const ext = db.prepare('SELECT principal_hoc_vi, principal_don_vi, principal_orcid FROM missions WHERE id = ?').get(id);
    if (ext) {
      mission.principal_hoc_vi = ext.principal_hoc_vi || '';
      mission.principal_don_vi = ext.principal_don_vi || '';
      mission.principal_orcid = ext.principal_orcid || '';
    }
  } catch (e) {
    mission.principal_hoc_vi = mission.principal_don_vi = mission.principal_orcid = '';
  }
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const principal = (mission.principal || '').trim();
  const ongoingStatuses = ['cho_vien_xet_chon', 'cho_ct_hd_xet_duyet', 'buoc4a', 'buoc4b', 'cho_bo_tham_dinh', 'cho_ngoai_xet_chon', 'cho_phe_duyet_ngoai', 'da_phe_duyet', 'approved', 'cho_ky_hop_dong', 'dang_thuc_hien', 'ongoing', 'xin_dieu_chinh', 'cho_nghiem_thu_co_so', 'nghiem_thu_trung_gian', 'review', 'cho_nghiem_thu_bo_nn', 'nghiem_thu_tong_ket', 'hoan_thien_sau_nghiem_thu', 'thanh_ly_hop_dong'];
  const ongoing = principal ? db.prepare(
    'SELECT id, code, title, level, status FROM missions WHERE id != ? AND LOWER(TRIM(principal)) = LOWER(?) AND status IN (' + ongoingStatuses.map(() => '?').join(',') + ') ORDER BY start_date DESC'
  ).all(id, principal, ...ongoingStatuses) : [];
  const nationalCount = ongoing.filter(m => (m.level || '').toLowerCase() === 'national').length;
  const totalCount = ongoing.length;
  const warningNational = nationalCount >= 1;
  const warningMaxCount = totalCount >= 3;
  return res.json({
    principal: mission.principal || '',
    principal_hoc_vi: mission.principal_hoc_vi || '',
    principal_don_vi: mission.principal_don_vi || '',
    principal_orcid: mission.principal_orcid || '',
    level: mission.level || '',
    ongoing,
    warning_dieu10_national: warningNational,
    warning_dieu10_max: warningMaxCount
  });
});

app.get('/api/missions/:id/files/:fileId/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const row = db.prepare('SELECT id, mission_id, original_name, path FROM missions_files WHERE id = ? AND mission_id = ?').get(fileId, id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  const fullPath = path.join(__dirname, 'uploads', row.path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ message: 'File không tồn tại' });
  const safeName = (row.original_name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
  return res.sendFile(fullPath);
});

// Xem file inline (PDF viewer) — cần token trong URL hoặc cookie
app.get('/api/missions/:id/files/:fileId/view', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const row = db.prepare('SELECT id, mission_id, original_name, path FROM missions_files WHERE id = ? AND mission_id = ?').get(fileId, id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  const fullPath = path.join(__dirname, 'uploads', row.path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ message: 'File không tồn tại' });
  const ext = (row.original_name || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + (row.original_name || 'view.pdf').replace(/[^a-zA-Z0-9._-]/g, '_') + '"');
  }
  return res.sendFile(fullPath);
});

// Bước 2 — Thư ký/Admin: Hồ sơ hợp lệ → chuyển sang Bước 3 (Chờ CT HĐ KHCN xét duyệt)
app.post('/api/missions/:id/step2-approve', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, code, title, principal, level, status FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.status || '') !== 'cho_vien_xet_chon') {
    return res.status(400).json({ message: 'Chỉ thực hiện khi đề tài đang ở bước 2 (Phòng KHCN kiểm tra)' });
  }
  const now = new Date().toISOString();
  const nhanh = computeNhanhFromLevel(mission.level);
  db.prepare(`UPDATE missions SET status = ?, buoc3_trang_thai = ?, buoc3_ngay_gui = ?, nhanh = ? WHERE id = ?`).run('cho_ct_hd_xet_duyet', 'cho_xet_duyet', now, nhanh, id);
  const actor = (req.user.fullname || req.user.email || 'Thư ký').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const chairmanEmail = getChairmanEmail();
  const reviewUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/ct-hd-xet-duyet-de-tai.html?id=' + id;
  if (transporter && chairmanEmail) {
    const subject = '[Đề tài ngoài Viện] Có 1 đề tài chờ anh/chị xét duyệt: ' + (mission.title || '');
    const text = 'Phòng KHCN&QHĐN đã xác nhận hồ sơ hợp lệ. Có 1 đề tài chờ anh/chị xét duyệt: "' + (mission.title || '') + '" (Chủ nhiệm: ' + (mission.principal || '') + '). Vào xem và điền phiếu nhận xét: ' + reviewUrl;
    const html = '<p>Phòng KHCN&QHĐN (' + actor + ') đã xác nhận hồ sơ hợp lệ.</p><p><strong>Có 1 đề tài chờ anh/chị xét duyệt:</strong> ' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + ' (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ').</p><p>Vui lòng vào xem thuyết minh và điền phiếu nhận xét.</p><p><a href="' + reviewUrl + '" style="color:#1565c0;font-weight:600">Vào trang xét duyệt</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: chairmanEmail, subject, text, html }).catch(err => console.error('[Email]', err.message));
  }
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Phòng KHCN đã chuyển lên Bước 3: ' + (mission.title || '');
    const html = '<p>Phòng KHCN&QHĐN đã xác nhận hồ sơ hợp lệ. Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> đã chuyển sang <strong>Bước 3 — Chờ CT HĐ KHCN xét duyệt</strong>.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã chuyển sang Bước 3 (Chờ CT HĐ xét duyệt). Email đã gửi đến Chủ tịch Hội đồng.', status: 'cho_ct_hd_xet_duyet' });
});

// Bước 2 — Thư ký/Admin: Yêu cầu bổ sung (hồ sơ vẫn ở bước 2)
app.post('/api/missions/:id/step2-request-supplement', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, code, title, principal, status FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.status || '') !== 'cho_vien_xet_chon') {
    return res.status(400).json({ message: 'Chỉ thực hiện khi đề tài đang ở bước 2' });
  }
  const note = (req.body && req.body.note) ? String(req.body.note).trim() : '';
  const actor = (req.user.fullname || req.user.email || 'Thư ký').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Yêu cầu bổ sung hồ sơ: ' + (mission.title || '');
    const noteBlock = note ? '<p><strong>Nội dung yêu cầu bổ sung:</strong></p><p>' + note.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>' : '';
    const text = 'Phòng KHCN&QHĐN đã yêu cầu bổ sung hồ sơ cho đề tài "' + (mission.title || '') + '". ' + (note ? 'Nội dung: ' + note : '') + ' Xem: ' + timelineUrl;
    const html = '<p>Phòng KHCN&QHĐN (' + actor + ') đã yêu cầu bổ sung hồ sơ cho đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ').</p>' + noteBlock + '<p>Hồ sơ vẫn ở bước 2. Chủ nhiệm cần bổ sung theo yêu cầu.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình đề tài</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text, html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã gửi yêu cầu bổ sung. Email đã gửi đến Chủ nhiệm và Hội đồng.' });
});

// Bước 2 — Thư ký/Admin: Từ chối
app.post('/api/missions/:id/step2-reject', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, code, title, principal, status FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.status || '') !== 'cho_vien_xet_chon') {
    return res.status(400).json({ message: 'Chỉ thực hiện khi đề tài đang ở bước 2' });
  }
  const reason = (req.body && req.body.reason) ? String(req.body.reason).trim() : '';
  db.prepare('UPDATE missions SET status = ? WHERE id = ?').run('khong_duoc_phe_duyet', id);
  const actor = (req.user.fullname || req.user.email || 'Thư ký').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Đề xuất không được chấp thuận: ' + (mission.title || '');
    const reasonBlock = reason ? '<p><strong>Lý do:</strong></p><p>' + reason.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>' : '';
    const text = 'Phòng KHCN&QHĐN đã từ chối đề xuất "' + (mission.title || '') + '". ' + (reason ? 'Lý do: ' + reason : '') + ' Xem: ' + timelineUrl;
    const html = '<p>Phòng KHCN&QHĐN (' + actor + ') đã từ chối đề xuất đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ').</p>' + reasonBlock + '<p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình đề tài</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text, html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã từ chối đề xuất. Email đã gửi đến Hội đồng.', status: 'khong_duoc_phe_duyet' });
});

// Bước 3 — CT HĐ KHCN: Submit phiếu nhận xét
app.post('/api/missions/:id/step3-submit', authMiddleware, chuTichOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, code, title, principal, level, status, buoc3_trang_thai, buoc3_lan_xet_thu FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.buoc3_trang_thai || '') !== 'cho_xet_duyet') {
    return res.status(400).json({ message: 'Đề tài không ở trạng thái chờ xét duyệt' });
  }
  const body = req.body || {};
  const ketQua = (body.ket_qua || '').trim();
  const validKetQua = ['dong_y', 'dong_y_co_dieu_kien', 'khong_dong_y'];
  if (!validKetQua.includes(ketQua)) return res.status(400).json({ message: 'Kết luận phải là: dong_y, dong_y_co_dieu_kien, hoặc khong_dong_y' });
  const nhanXetKhoaHoc = (body.nhan_xet_khoa_hoc || '').trim();
  const nhanXetKhaThi = (body.nhan_xet_kha_thi || '').trim();
  const nhanXetDinhHuong = (body.nhan_xet_dinh_huong || '').trim();
  const nhanXetNangLuc = (body.nhan_xet_nang_luc || '').trim();
  if (!nhanXetKhoaHoc || !nhanXetKhaThi || !nhanXetDinhHuong || !nhanXetNangLuc) {
    return res.status(400).json({ message: 'Vui lòng điền đủ 4 mục nhận xét' });
  }
  if (ketQua === 'dong_y_co_dieu_kien') {
    const dieuKien = (body.dieu_kien || '').trim();
    if (!dieuKien) return res.status(400).json({ message: 'Đồng ý có điều kiện cần ghi rõ điều kiện' });
  }
  if (ketQua === 'khong_dong_y') {
    const lyDo = (body.ly_do_tu_choi || '').trim();
    if (!lyDo) return res.status(400).json({ message: 'Không đồng ý cần ghi rõ lý do' });
  }
  const now = new Date().toISOString();
  const lanXet = (mission.buoc3_lan_xet_thu || 1);
  const dieuKien = (body.dieu_kien || '').trim() || null;
  const lyDoTuChoi = (body.ly_do_tu_choi || '').trim() || null;
  const nhanXetJson = JSON.stringify({ nhan_xet_khoa_hoc: nhanXetKhoaHoc, nhan_xet_kha_thi: nhanXetKhaThi, nhan_xet_dinh_huong: nhanXetDinhHuong, nhan_xet_nang_luc: nhanXetNangLuc });
  db.prepare(`UPDATE missions SET buoc3_trang_thai = ?, buoc3_ngay_phan_hoi = ?, buoc3_nguoi_xet_duyet_id = ?, buoc3_ket_qua = ?, buoc3_dieu_kien = ?, buoc3_ly_do_tu_choi = ?, buoc3_nhan_xet_khoa_hoc = ?, buoc3_nhan_xet_kha_thi = ?, buoc3_nhan_xet_dinh_huong = ?, buoc3_nhan_xet_nang_luc = ? WHERE id = ?`).run('da_xet_duyet', now, req.user.id, ketQua, dieuKien, lyDoTuChoi, nhanXetKhoaHoc, nhanXetKhaThi, nhanXetDinhHuong, nhanXetNangLuc, id);
  db.prepare('INSERT INTO lich_su_buoc3 (mission_id, lan_xet, nguoi_xet_id, ngay_xet, ket_qua, nhan_xet_json, dieu_kien, ly_do_tu_choi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, lanXet, req.user.id, now, ketQua, nhanXetJson, dieuKien, lyDoTuChoi);
  const actor = (req.user.fullname || req.user.email || 'CT HĐ').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const ketQuaLabels = { dong_y: 'Đồng ý', dong_y_co_dieu_kien: 'Đồng ý có điều kiện', khong_dong_y: 'Không đồng ý' };
    const subject = ketQua === 'khong_dong_y' ? '[Đề tài ngoài Viện] CT HĐ yêu cầu chỉnh sửa / từ chối: ' + (mission.title || '') : '[Đề tài ngoài Viện] CT HĐ đã đồng ý — chờ xác nhận chuyển bước 4: ' + (mission.title || '');
    const html = ketQua === 'khong_dong_y'
      ? '<p>CT HĐ KHCN (' + actor + ') đã ' + (ketQuaLabels[ketQua] || ketQua) + ' đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong>.</p><p>Vui lòng xử lý.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>'
      : '<p>CT HĐ KHCN (' + actor + ') đã ' + (ketQuaLabels[ketQua] || ketQua) + ' đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong>.</p><p>Vui lòng xác nhận chuyển bước 4.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã gửi phiếu nhận xét. Email đã gửi đến Phòng KHCN.', buoc3_ket_qua: ketQua });
});

// Bước 3 — Phòng KHCN: Xác nhận chuyển bước 4A (Nhánh A)
app.post('/api/missions/:id/step3-confirm-4a', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status, buoc3_trang_thai, buoc3_ket_qua, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.buoc3_trang_thai || '') !== 'da_xet_duyet') {
    return res.status(400).json({ message: 'Đề tài chưa được CT HĐ xét duyệt' });
  }
  if (mission.buoc3_ket_qua === 'khong_dong_y') {
    return res.status(400).json({ message: 'CT HĐ không đồng ý — không thể chuyển bước 4' });
  }
  if ((mission.nhanh || '') !== 'A') {
    return res.status(400).json({ message: 'Đề tài thuộc Nhánh B — dùng nút chuyển bước 4B' });
  }
  db.prepare('UPDATE missions SET status = ?, buoc3_trang_thai = ? WHERE id = ?').run('buoc4a', 'hoan_thanh', id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Đề tài đã được duyệt nội bộ — chuyển Bước 4A: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') đã được duyệt nội bộ, chuyển sang <strong>Bước 4A</strong>.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã chuyển sang Bước 4A. Email đã gửi đến Chủ nhiệm và Hội đồng.', status: 'buoc4a' });
});

// Bước 3 — Phòng KHCN: Xác nhận chuyển bước 4B (Nhánh B)
app.post('/api/missions/:id/step3-confirm-4b', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status, buoc3_trang_thai, buoc3_ket_qua, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.buoc3_trang_thai || '') !== 'da_xet_duyet') {
    return res.status(400).json({ message: 'Đề tài chưa được CT HĐ xét duyệt' });
  }
  if (mission.buoc3_ket_qua === 'khong_dong_y') {
    return res.status(400).json({ message: 'CT HĐ không đồng ý — không thể chuyển bước 4' });
  }
  if ((mission.nhanh || '') !== 'B') {
    return res.status(400).json({ message: 'Đề tài thuộc Nhánh A — dùng nút chuyển bước 4A' });
  }
  db.prepare('UPDATE missions SET status = ?, buoc3_trang_thai = ? WHERE id = ?').run('buoc4b', 'hoan_thanh', id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Đề tài đã được duyệt nội bộ — chuyển Bước 4B: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') đã được duyệt nội bộ, chuyển sang <strong>Bước 4B</strong>.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã chuyển sang Bước 4B. Email đã gửi đến Chủ nhiệm và Hội đồng.', status: 'buoc4b' });
});

// Bước 3 — Phòng KHCN: Yêu cầu CN chỉnh sửa và nộp lại (chỉ khi lần 1)
app.post('/api/missions/:id/step3-request-revision', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, buoc3_trang_thai, buoc3_ket_qua, buoc3_lan_xet_thu FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.buoc3_trang_thai || '') !== 'da_xet_duyet') {
    return res.status(400).json({ message: 'Đề tài chưa được CT HĐ xét duyệt' });
  }
  if (mission.buoc3_ket_qua !== 'khong_dong_y') {
    return res.status(400).json({ message: 'Chỉ áp dụng khi CT HĐ không đồng ý' });
  }
  const lanXet = mission.buoc3_lan_xet_thu || 1;
  if (lanXet >= 2) {
    return res.status(400).json({ message: 'Đã xét lần 2 — không thể yêu cầu chỉnh sửa thêm. Dùng "Dừng hồ sơ đợt này".' });
  }
  db.prepare('UPDATE missions SET buoc3_trang_thai = ?, buoc3_lan_xet_thu = ?, buoc3_nguoi_xet_duyet_id = NULL, buoc3_ngay_phan_hoi = NULL, buoc3_ket_qua = NULL, buoc3_dieu_kien = NULL, buoc3_ly_do_tu_choi = NULL, buoc3_nhan_xet_khoa_hoc = NULL, buoc3_nhan_xet_kha_thi = NULL, buoc3_nhan_xet_dinh_huong = NULL, buoc3_nhan_xet_nang_luc = NULL WHERE id = ?').run('cho_xet_duyet', 2, id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Yêu cầu chỉnh sửa thuyết minh: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') — CT HĐ yêu cầu chỉnh sửa. Vui lòng cập nhật thuyết minh và nộp lại.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã yêu cầu CN chỉnh sửa và nộp lại. Email đã gửi.', buoc3_trang_thai: 'cho_xet_duyet' });
});

// Bước 3 — Phòng KHCN: Dừng hồ sơ đợt này
app.post('/api/missions/:id/step3-stop', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  db.prepare('UPDATE missions SET status = ?, buoc3_trang_thai = ? WHERE id = ?').run('dung_khong_dat_dot', 'tu_choi', id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Đề tài dừng xét duyệt đợt này: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') đã dừng xét duyệt đợt này.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã dừng hồ sơ đợt này.', status: 'dung_khong_dat_dot' });
});

// Reset về Bước 3 & đổi nhánh (chỉ admin, phong_khcn)
const BUOC4_STATUSES = ['buoc4a', 'buoc4b', 'cho_bo_tham_dinh', 'cho_ngoai_xet_chon', 'cho_phe_duyet_ngoai'];
app.post('/api/missions/:id/reset-ve-buoc3', authMiddleware, adminOrPhongKhcn, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status, nhanh, level, lan_phan_nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const { ly_do, nhanh_moi, cap_moi } = req.body || {};
  const lyDoTrim = (ly_do || '').trim();
  if (lyDoTrim.length < 20) return res.status(400).json({ message: 'Lý do thay đổi phải có ít nhất 20 ký tự' });
  if (!nhanh_moi || !['A', 'B'].includes(nhanh_moi)) return res.status(400).json({ message: 'Nhánh mới không hợp lệ' });
  if (!cap_moi || typeof cap_moi !== 'string') return res.status(400).json({ message: 'Cấp đề tài mới không hợp lệ' });
  if (BUOC4_STATUSES.indexOf(mission.status || '') < 0) {
    return res.status(403).json({ message: 'Chỉ được reset khi đề tài đang ở Bước 4. Đã có QĐ phê duyệt thì không cho reset.' });
  }
  const b5 = db.prepare('SELECT id, trang_thai FROM buoc5 WHERE mission_id = ?').get(id);
  if (b5 && (b5.trang_thai || '') === 'hoan_thanh') {
    return res.status(403).json({ message: 'Đề tài đã có QĐ phê duyệt — không cho reset.' });
  }
  const nhanhCu = mission.nhanh || 'A';
  const capCu = mission.level || '';
  const now = new Date().toISOString();
  const lanPhanNhanh = (mission.lan_phan_nhanh || 1) + 1;
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  const b4b = db.prepare('SELECT * FROM buoc4b WHERE mission_id = ?').get(id);
  const buoc4Snapshot = JSON.stringify({ buoc4a: b4a || null, buoc4b: b4b || null });
  db.prepare('INSERT INTO lich_su_doi_nhanh (mission_id, nhanh_cu, nhanh_moi, cap_cu, cap_moi, ly_do, reset_boi, reset_luc, buoc4_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, nhanhCu, nhanh_moi, capCu, cap_moi, lyDoTrim, req.user.id, now, buoc4Snapshot);
  db.prepare('UPDATE missions SET nhanh = ?, level = ?, status = ?, buoc3_trang_thai = ?, buoc3_nguoi_xet_duyet_id = NULL, buoc3_ngay_phan_hoi = NULL, buoc3_ket_qua = NULL, buoc3_dieu_kien = NULL, buoc3_ly_do_tu_choi = NULL, buoc3_nhan_xet_khoa_hoc = NULL, buoc3_nhan_xet_kha_thi = NULL, buoc3_nhan_xet_dinh_huong = NULL, buoc3_nhan_xet_nang_luc = NULL, lan_phan_nhanh = ? WHERE id = ?').run(nhanh_moi, cap_moi, 'cho_ct_hd_xet_duyet', 'cho_xet_duyet', lanPhanNhanh, id);
  if (b4a) db.prepare('UPDATE buoc4a SET trang_thai = ? WHERE mission_id = ?').run('da_reset', id);
  if (b4b) db.prepare('UPDATE buoc4b SET trang_thai = ? WHERE mission_id = ?').run('da_reset', id);
  db.prepare('INSERT INTO lich_su_buoc (mission_id, action, user_id, timestamp, note) VALUES (?, ?, ?, ?, ?)').run(id, 'reset_ve_buoc3', req.user.id, now, lyDoTrim);
  const nhanhLabel = nhanh_moi === 'A' ? 'Nhánh A — Bộ GD/ĐHQG/Trường' : 'Nhánh B — Nhà nước/NAFOSTED';
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const resetByName = (req.user.fullname || req.user.email || 'Admin').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const subject = '[Đề tài ngoài Viện] Đề tài được chuyển lại Bước 3 để phân nhánh lại: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> được chuyển lại Bước 3 để phân nhánh lại.</p><p><strong>Lý do:</strong> ' + lyDoTrim.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p><p><strong>Nhánh mới:</strong> ' + nhanhLabel + '</p><p>Reset bởi: ' + resetByName + '</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã chuyển lại Bước 3 và đổi nhánh.', status: 'cho_ct_hd_xet_duyet', nhanh: nhanh_moi, level: cap_moi, lan_phan_nhanh: lanPhanNhanh });
});

// ========== BƯỚC 4 NHÁNH A — Xét chọn tại Viện & gửi Bộ ==========

// Sub-bước ① — Lên lịch họp HĐ
app.post('/api/missions/:id/buoc4a/len-lich', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const { hop_ngay, hop_hinh_thuc, hop_dia_diem, hop_link, thanh_phan_ids, ghi_chu } = req.body || {};
  if (!hop_ngay || !hop_hinh_thuc) return res.status(400).json({ message: 'Thiếu ngày giờ họp hoặc hình thức họp' });
  const ids = Array.isArray(thanh_phan_ids) ? thanh_phan_ids : (typeof thanh_phan_ids === 'string' ? JSON.parse(thanh_phan_ids || '[]') : []);
  if (ids.length < 2) return res.status(400).json({ message: 'Cần ít nhất 2 thành viên Hội đồng' });
  const hopDate = new Date(hop_ngay);
  const now = new Date();
  if (hopDate.getTime() - now.getTime() < 2 * 60 * 60 * 1000) return res.status(400).json({ message: 'Ngày giờ họp phải sau ít nhất 2 giờ' });
  const thanhPhanJson = JSON.stringify(ids);
  let row;
  try {
    row = db.prepare('SELECT id FROM buoc4a WHERE mission_id = ?').get(id);
  } catch (e) {
    row = null;
  }
  const nowStr = new Date().toISOString();
  if (row) {
    db.prepare('UPDATE buoc4a SET hop_trang_thai = ?, hop_ngay = ?, hop_hinh_thuc = ?, hop_dia_diem = ?, hop_link = ?, thanh_phan_ids = ?, ghi_chu = ?, updated_at = ? WHERE mission_id = ?')
      .run('da_len_lich', hop_ngay, hop_hinh_thuc || null, hop_dia_diem || null, hop_link || null, thanhPhanJson, ghi_chu || null, nowStr, id);
  } else {
    db.prepare('INSERT INTO buoc4a (mission_id, hop_trang_thai, hop_ngay, hop_hinh_thuc, hop_dia_diem, hop_link, thanh_phan_ids, ghi_chu) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'da_len_lich', hop_ngay, hop_hinh_thuc, hop_dia_diem || null, hop_link || null, thanhPhanJson, ghi_chu || null);
  }
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)')
    .run(id, '1', 'len_lich', userId, JSON.stringify({ hop_ngay, hop_hinh_thuc, hop_dia_diem, hop_link }));
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Lịch họp HĐ chuyên ngành: ' + (mission.title || '');
    const hinhThuc = hop_hinh_thuc === 'offline' ? 'Offline' : hop_hinh_thuc === 'online' ? 'Online' : 'Hybrid';
    const diaDiem = hop_hinh_thuc === 'offline' ? (hop_dia_diem || '—') : (hop_link || '—');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> — Lịch họp HĐ chuyên ngành đã được lên.</p><p><strong>Ngày giờ:</strong> ' + hop_ngay + '</p><p><strong>Hình thức:</strong> ' + hinhThuc + '</p><p><strong>Địa điểm/Link:</strong> ' + (diaDiem || '').replace(/</g, '&lt;') + '</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã lên lịch họp và gửi thông báo.', hop_trang_thai: 'da_len_lich' });
});

// Sub-bước ① — Chỉnh lịch (chỉ khi hop_ngay > now + 1 giờ)
app.patch('/api/missions/:id/buoc4a/chinh-lich', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const b4a = db.prepare('SELECT hop_ngay, hop_trang_thai FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.hop_trang_thai || '') !== 'da_len_lich') return res.status(400).json({ message: 'Chưa lên lịch hoặc không thể chỉnh' });
  const hopDate = new Date(b4a.hop_ngay);
  if (hopDate.getTime() - Date.now() < 60 * 60 * 1000) return res.status(400).json({ message: 'Không thể chỉnh lịch khi còn dưới 1 giờ' });
  const { hop_ngay, hop_hinh_thuc, hop_dia_diem, hop_link, thanh_phan_ids, ghi_chu } = req.body || {};
  const updates = []; const params = [];
  if (hop_ngay) { updates.push('hop_ngay = ?'); params.push(hop_ngay); }
  if (hop_hinh_thuc) { updates.push('hop_hinh_thuc = ?'); params.push(hop_hinh_thuc); }
  if (hop_dia_diem !== undefined) { updates.push('hop_dia_diem = ?'); params.push(hop_dia_diem || null); }
  if (hop_link !== undefined) { updates.push('hop_link = ?'); params.push(hop_link || null); }
  if (thanh_phan_ids) { const ids = Array.isArray(thanh_phan_ids) ? thanh_phan_ids : JSON.parse(thanh_phan_ids || '[]'); if (ids.length >= 2) { updates.push('thanh_phan_ids = ?'); params.push(JSON.stringify(ids)); } }
  if (ghi_chu !== undefined) { updates.push('ghi_chu = ?'); params.push(ghi_chu || null); }
  if (updates.length === 0) return res.status(400).json({ message: 'Không có thay đổi' });
  params.push(new Date().toISOString(), id);
  db.prepare('UPDATE buoc4a SET ' + updates.join(', ') + ', updated_at = ? WHERE mission_id = ?').run(...params);
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)').run(id, '1', 'chinh_lich', userId, JSON.stringify(req.body));
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Lịch họp đã thay đổi: ' + (mission.title || '');
    const html = '<p>Lịch họp HĐ chuyên ngành cho đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> đã được cập nhật.</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã cập nhật lịch họp.' });
});

// Sub-bước ② — Kết quả họp HĐ (CT HĐ hoặc Phòng KHCN)
function chuTichOrThuyKyOrAdmin(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (!['admin', 'chu_tich', 'thu_ky'].includes(role)) return res.status(403).json({ message: 'Chỉ CT HĐ KHCN hoặc Phòng KHCN mới có quyền này' });
  next();
}
app.post('/api/missions/:id/buoc4a/ket-qua-hop', authMiddleware, chuTichOrThuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.hop_trang_thai || '') !== 'da_len_lich') return res.status(400).json({ message: 'Chưa lên lịch họp' });
  if (b4a.hd_ket_luan) return res.status(400).json({ message: 'Đã lưu kết quả họp, không thể sửa' });
  const { ngay_hop_thuc_te, ket_luan, noi_dung_chinh_sua, han_chinh_sua, ly_do, nhan_xet, bien_ban_file_id } = req.body || {};
  if (!ket_luan || !bien_ban_file_id) return res.status(400).json({ message: 'Thiếu kết luận hoặc biên bản họp' });
  const validKetLuan = ['thong_qua', 'thong_qua_co_chinh_sua', 'khong_thong_qua'];
  if (!validKetLuan.includes(ket_luan)) return res.status(400).json({ message: 'Kết luận không hợp lệ' });
  if (ket_luan === 'thong_qua_co_chinh_sua' && (!noi_dung_chinh_sua || !han_chinh_sua)) return res.status(400).json({ message: 'Thông qua có chỉnh sửa cần nội dung và hạn' });
  if (ket_luan === 'khong_thong_qua' && !ly_do) return res.status(400).json({ message: 'Không thông qua cần lý do' });
  const ngayHop = ngay_hop_thuc_te || b4a.hop_ngay;
  db.prepare('UPDATE buoc4a SET ngay_hop_thuc_te = ?, hd_ket_luan = ?, noi_dung_chinh_sua = ?, han_chinh_sua = ?, ly_do = ?, nhan_xet = ?, bien_ban_file_id = ?, trang_thai = ?, updated_at = ? WHERE mission_id = ?')
    .run(ngayHop, ket_luan, noi_dung_chinh_sua || null, han_chinh_sua || null, ly_do || null, nhan_xet || null, bien_ban_file_id, 'da_hop', new Date().toISOString(), id);
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)').run(id, '2', 'ket_qua_hop', userId, JSON.stringify({ ket_luan }));
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Kết quả họp HĐ: ' + (mission.title || '');
    const kqLabel = ket_luan === 'thong_qua' ? 'Thông qua' : ket_luan === 'thong_qua_co_chinh_sua' ? 'Thông qua — yêu cầu chỉnh sửa' : 'Không thông qua';
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> — Kết quả họp HĐ: <strong>' + kqLabel + '</strong></p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã lưu kết quả họp.', hd_ket_luan: ket_luan });
});

// Sub-bước ③ — Gửi Bộ
app.post('/api/missions/:id/buoc4a/gui-bo', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh, level FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a) return res.status(400).json({ message: 'Chưa có dữ liệu bước 4A' });
  const kl = b4a.hd_ket_luan || '';
  if (kl === 'khong_thong_qua') return res.status(400).json({ message: 'HĐ không thông qua — không thể gửi Bộ' });
  if (kl === 'thong_qua_co_chinh_sua' && !b4a.thuyet_minh_chinh_sua_ok) return res.status(400).json({ message: 'Chờ CN upload thuyết minh chỉnh sửa và Phòng KHCN xác nhận' });
  const { co_quan_nhan, danh_muc_file_id, ngay_gui, hinh_thuc_gui, nguoi_nhan, ghi_chu } = req.body || {};
  if (!co_quan_nhan || !danh_muc_file_id || !ngay_gui) return res.status(400).json({ message: 'Thiếu cơ quan nhận, file danh mục hoặc ngày gửi' });
  db.prepare('UPDATE buoc4a SET co_quan_nhan = ?, danh_muc_file_id = ?, ngay_gui = ?, hinh_thuc_gui = ?, nguoi_nhan = ?, gui_ghi_chu = ?, trang_thai = ?, updated_at = ? WHERE mission_id = ?')
    .run(co_quan_nhan, danh_muc_file_id, ngay_gui, hinh_thuc_gui || null, nguoi_nhan || null, ghi_chu || null, 'da_gui_bo', new Date().toISOString(), id);
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)').run(id, '3', 'gui_bo', userId, JSON.stringify({ co_quan_nhan, ngay_gui }));
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Đã gửi danh mục lên Bộ: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> — Danh mục đã gửi ' + (co_quan_nhan || '').replace(/</g, '&lt;') + ' ngày ' + ngay_gui + '.</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã xác nhận gửi lên Bộ.', trang_thai: 'da_gui_bo' });
});

// Sub-bước ④ — Kết quả thẩm định từ Bộ
app.post('/api/missions/:id/buoc4a/ket-qua-bo', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.trang_thai || '') !== 'da_gui_bo') return res.status(400).json({ message: 'Chưa gửi Bộ' });
  const { ngay_nhan, ket_qua, noi_dung_yc, han_yc, ly_do, van_ban_file_id, ghi_chu } = req.body || {};
  if (!ngay_nhan || !ket_qua) return res.status(400).json({ message: 'Thiếu ngày nhận hoặc kết quả' });
  const validKq = ['lot', 'yeu_cau_chinh_sua', 'khong_lot'];
  if (!validKq.includes(ket_qua)) return res.status(400).json({ message: 'Kết quả không hợp lệ' });
  if (ket_qua === 'yeu_cau_chinh_sua' && (!noi_dung_yc || !han_yc)) return res.status(400).json({ message: 'Yêu cầu chỉnh sửa cần nội dung và hạn' });
  db.prepare('UPDATE buoc4a SET ngay_nhan_ket_qua = ?, ket_qua_bo = ?, bo_noi_dung_yc = ?, bo_han_yc = ?, bo_ly_do = ?, van_ban_bo_file_id = ?, ket_qua_ghi_chu = ?, updated_at = ? WHERE mission_id = ?')
    .run(ngay_nhan, ket_qua, noi_dung_yc || null, han_yc || null, ly_do || null, van_ban_file_id || null, ghi_chu || null, new Date().toISOString(), id);
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)').run(id, '4', 'ket_qua_bo', userId, JSON.stringify({ ket_qua }));
  if (ket_qua === 'lot') {
    db.prepare('UPDATE buoc4a SET trang_thai = ? WHERE mission_id = ?').run('lot_danh_muc', id);
  } else if (ket_qua === 'khong_lot') {
    db.prepare('UPDATE buoc4a SET trang_thai = ? WHERE mission_id = ?').run('khong_lot', id);
  }
  return res.json({ success: true, message: 'Đã lưu kết quả thẩm định.', ket_qua_bo: ket_qua });
});

// Chuyển sang Bước 5 (khi lọt danh mục)
app.post('/api/missions/:id/buoc4a/chuyen-buoc5', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.ket_qua_bo || '') !== 'lot') return res.status(400).json({ message: 'Chưa lọt danh mục' });
  db.prepare('UPDATE missions SET status = ? WHERE id = ?').run('cho_phe_duyet_chinh_thuc', id);
  db.prepare('UPDATE buoc4a SET trang_thai = ? WHERE mission_id = ?').run('hoan_thanh', id);
  try { db.prepare('INSERT INTO buoc5 (mission_id) VALUES (?)').run(id); } catch (e) {}
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Chuyển Bước 5: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> đã lọt danh mục — chuyển sang Bước 5 (Chờ phê duyệt chính thức).</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã chuyển sang Bước 5.', status: 'cho_phe_duyet_chinh_thuc' });
});

// CN upload thuyết minh chỉnh sửa (khi HĐ yêu cầu)
app.post('/api/missions/:id/buoc4a/cn-upload-thuyet-minh-chinh-sua', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.hd_ket_luan || '') !== 'thong_qua_co_chinh_sua') return res.status(400).json({ message: 'Không trong trạng thái yêu cầu chỉnh sửa' });
  const han = b4a.han_chinh_sua ? new Date(b4a.han_chinh_sua) : null;
  if (han && Date.now() > han.getTime()) return res.status(400).json({ message: 'Đã quá hạn nộp' });
  const { file_id } = req.body || {};
  if (!file_id) return res.status(400).json({ message: 'Thiếu file_id' });
  db.prepare('UPDATE buoc4a SET thuyet_minh_chinh_sua_ok = 1, updated_at = ? WHERE mission_id = ?').run(new Date().toISOString(), id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const mission = db.prepare('SELECT title FROM missions WHERE id = ?').get(id);
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] CN đã nộp thuyết minh chỉnh sửa: ' + (mission ? mission.title : '');
    const html = '<p>Chủ nhiệm đã upload thuyết minh chỉnh sửa. Vui lòng xác nhận để mở khóa gửi Bộ.</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã lưu thuyết minh chỉnh sửa.' });
});

// Phòng KHCN xác nhận thuyết minh chỉnh sửa
app.post('/api/missions/:id/buoc4a/xac-nhan-thuyet-minh-chinh-sua', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.hd_ket_luan || '') !== 'thong_qua_co_chinh_sua') return res.status(400).json({ message: 'Không trong trạng thái yêu cầu chỉnh sửa' });
  db.prepare('UPDATE buoc4a SET thuyet_minh_chinh_sua_ok = 1, updated_at = ? WHERE mission_id = ?').run(new Date().toISOString(), id);
  return res.json({ success: true, message: 'Đã xác nhận. Sub-bước 3 mở khóa.' });
});

// ========== BƯỚC 4 NHÁNH B ==========
app.post('/api/missions/:id/buoc4b/nop-ho-so', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission || (mission.nhanh || '') !== 'B') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh B' });
  const { co_quan_nhan, han_nop, ngay_nop_thuc_te, hinh_thuc_nop, ma_ho_so, ghi_chu } = req.body || {};
  if (!co_quan_nhan || !han_nop || !ngay_nop_thuc_te) return res.status(400).json({ message: 'Thiếu cơ quan nhận, hạn nộp hoặc ngày nộp thực tế' });
  let row = db.prepare('SELECT id FROM buoc4b WHERE mission_id = ?').get(id);
  const nowStr = new Date().toISOString();
  if (row) {
    db.prepare('UPDATE buoc4b SET co_quan_nhan = ?, han_nop = ?, ngay_nop_thuc_te = ?, hinh_thuc_nop = ?, ma_ho_so = ?, ghi_chu = ?, trang_thai = ?, updated_at = ? WHERE mission_id = ?')
      .run(co_quan_nhan, han_nop, ngay_nop_thuc_te, hinh_thuc_nop || null, ma_ho_so || null, ghi_chu || null, 'da_nop', nowStr, id);
  } else {
    db.prepare('INSERT INTO buoc4b (mission_id, co_quan_nhan, han_nop, ngay_nop_thuc_te, hinh_thuc_nop, ma_ho_so, ghi_chu, trang_thai) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, co_quan_nhan, han_nop, ngay_nop_thuc_te, hinh_thuc_nop || null, ma_ho_so || null, ghi_chu || null, 'da_nop');
  }
  db.prepare('UPDATE missions SET status = ? WHERE id = ?').run('cho_ngoai_xet_chon', id);
  return res.json({ success: true, message: 'Đã xác nhận nộp hồ sơ.', trang_thai: 'da_nop' });
});

app.post('/api/missions/:id/buoc4b/ket-qua', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission || (mission.nhanh || '') !== 'B') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh B' });
  const b4b = db.prepare('SELECT * FROM buoc4b WHERE mission_id = ?').get(id);
  if (!b4b || (b4b.trang_thai || '') !== 'da_nop') return res.status(400).json({ message: 'Chưa nộp hồ sơ' });
  const { ket_qua, noi_dung_yc, han_yc, ly_do, van_ban_file_id } = req.body || {};
  if (!ket_qua) return res.status(400).json({ message: 'Thiếu kết quả' });
  const validKq = ['duoc_tuyen_chon', 'yeu_cau_chinh_sua', 'khong_duoc'];
  if (!validKq.includes(ket_qua)) return res.status(400).json({ message: 'Kết quả không hợp lệ' });
  if (ket_qua === 'yeu_cau_chinh_sua' && (!noi_dung_yc || !han_yc)) return res.status(400).json({ message: 'Yêu cầu chỉnh sửa cần nội dung và hạn' });
  db.prepare('UPDATE buoc4b SET ket_qua = ?, noi_dung_yc = ?, han_yc = ?, ly_do = ?, van_ban_file_id = ?, updated_at = ? WHERE mission_id = ?')
    .run(ket_qua, noi_dung_yc || null, han_yc || null, ly_do || null, van_ban_file_id || null, new Date().toISOString(), id);
  if (ket_qua === 'duoc_tuyen_chon') {
    db.prepare('UPDATE missions SET status = ? WHERE id = ?').run('cho_phe_duyet_chinh_thuc', id);
    const existing = db.prepare('SELECT id FROM buoc5 WHERE mission_id = ?').get(id);
    if (!existing) db.prepare('INSERT INTO buoc5 (mission_id) VALUES (?)').run(id);
    const toList = getNotificationEmails();
    let principalEmail = null;
    const m = db.prepare('SELECT source_type, source_id FROM missions WHERE id = ?').get(id);
    if (m && m.source_type === 'cap_vien' && m.source_id) {
      const sub = dbCapVien.prepare('SELECT submittedById FROM cap_vien_submissions WHERE id = ?').get(m.source_id);
      if (sub && sub.submittedById) {
        const u = db.prepare('SELECT email FROM users WHERE id = ?').get(sub.submittedById);
        if (u && u.email) principalEmail = u.email.trim().toLowerCase();
      }
    }
    const recipients = new Set(toList.map(e => e.trim().toLowerCase()));
    if (principalEmail) recipients.add(principalEmail);
    if (transporter && recipients.size > 0) {
      const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
      const subject = '[Đề tài ngoài Viện] Đề tài được tuyển chọn — chuyển Bước 5: ' + (mission.title || '');
      const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') đã được cơ quan ngoài tuyển chọn — chuyển sang Bước 5 (Chờ phê duyệt chính thức & hoàn chỉnh thuyết minh).</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
      transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: Array.from(recipients).join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
    }
  }
  return res.json({ success: true, message: 'Đã lưu kết quả.', ket_qua });
});

// ========== BƯỚC 5 ==========
app.post('/api/missions/:id/buoc5/upload-thuyet-minh', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, status FROM missions WHERE id = ?').get(id);
  if (!mission || !['cho_phe_duyet_chinh_thuc', 'da_phe_duyet'].includes(mission.status)) return res.status(400).json({ message: 'Đề tài không ở Bước 5' });
  const { file_id, phien_ban, ghi_chu_thay_doi } = req.body || {};
  if (!file_id) return res.status(400).json({ message: 'Thiếu file_id' });
  db.prepare('INSERT INTO buoc5_thuyet_minh_ls (mission_id, file_id, phien_ban, ghi_chu, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, file_id, phien_ban || null, ghi_chu_thay_doi || null, req.user && req.user.id);
  return res.json({ success: true, message: 'Đã lưu thuyết minh hoàn chỉnh.' });
});

app.post('/api/missions/:id/buoc5/nhan-quyet-dinh', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const { so_qd, ngay_ky, co_quan_ky, file_id, ma_de_tai_chinh_thuc, kinh_phi, thoi_gian_bd, thoi_gian_kt } = req.body || {};
  if (!so_qd || !ngay_ky || !co_quan_ky || !file_id || kinh_phi == null || !thoi_gian_bd || !thoi_gian_kt) return res.status(400).json({ message: 'Thiếu thông tin bắt buộc' });
  const existing = db.prepare('SELECT id FROM buoc5 WHERE mission_id = ?').get(id);
  if (existing) {
    db.prepare('UPDATE buoc5 SET so_qd = ?, ngay_ky_qd = ?, co_quan_ky = ?, qd_file_id = ?, ma_de_tai_chinh_thuc = ?, kinh_phi = ?, thoi_gian_bd = ?, thoi_gian_kt = ?, trang_thai = ?, updated_at = ? WHERE mission_id = ?')
      .run(so_qd, ngay_ky, co_quan_ky, file_id, ma_de_tai_chinh_thuc || null, parseFloat(kinh_phi), thoi_gian_bd, thoi_gian_kt, 'hoan_thanh', new Date().toISOString(), id);
  } else {
    db.prepare('INSERT INTO buoc5 (mission_id, so_qd, ngay_ky_qd, co_quan_ky, qd_file_id, ma_de_tai_chinh_thuc, kinh_phi, thoi_gian_bd, thoi_gian_kt, trang_thai) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, so_qd, ngay_ky, co_quan_ky, file_id, ma_de_tai_chinh_thuc || null, parseFloat(kinh_phi), thoi_gian_bd, thoi_gian_kt, 'hoan_thanh');
  }
  db.prepare('UPDATE missions SET status = ?, approved_budget = ? WHERE id = ?').run('cho_ky_hop_dong', parseFloat(kinh_phi), id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Đã có QĐ phê duyệt: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> đã được phê duyệt chính thức. Chuyển sang Bước 6 (Ký hợp đồng).</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã xác nhận QĐ phê duyệt. Chuyển Bước 6.', status: 'cho_ky_hop_dong' });
});

// ========== BƯỚC 6 ==========
app.post('/api/missions/:id/buoc6/ky-hop-dong', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status FROM missions WHERE id = ?').get(id);
  if (!mission || (mission.status || '') !== 'cho_ky_hop_dong') return res.status(400).json({ message: 'Đề tài chưa ở Bước 6' });
  const { so_hd_ngoai, ngay_ky_ngoai, gia_tri_hd, file_hd_ngoai_id, so_hd_noi_bo, ngay_ky_noi_bo, file_hd_noi_bo_id, phi_quan_ly } = req.body || {};
  if (!so_hd_ngoai || !ngay_ky_ngoai || gia_tri_hd == null || !file_hd_ngoai_id || !so_hd_noi_bo || !ngay_ky_noi_bo || !file_hd_noi_bo_id) return res.status(400).json({ message: 'Thiếu thông tin hợp đồng' });
  const phi = phi_quan_ly != null ? parseFloat(phi_quan_ly) : (parseFloat(gia_tri_hd) || 0) * 0.03;
  try {
    db.prepare('INSERT INTO buoc6 (mission_id, so_hd_ngoai, ngay_ky_ngoai, gia_tri_hd, file_hd_ngoai_id, so_hd_noi_bo, ngay_ky_noi_bo, file_hd_noi_bo_id, phi_quan_ly) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, so_hd_ngoai, ngay_ky_ngoai, parseFloat(gia_tri_hd), file_hd_ngoai_id, so_hd_noi_bo, ngay_ky_noi_bo, file_hd_noi_bo_id, phi);
  } catch (e) {
    db.prepare('UPDATE buoc6 SET so_hd_ngoai = ?, ngay_ky_ngoai = ?, gia_tri_hd = ?, file_hd_ngoai_id = ?, so_hd_noi_bo = ?, ngay_ky_noi_bo = ?, file_hd_noi_bo_id = ?, phi_quan_ly = ?, updated_at = ? WHERE mission_id = ?')
      .run(so_hd_ngoai, ngay_ky_ngoai, parseFloat(gia_tri_hd), file_hd_ngoai_id, so_hd_noi_bo, ngay_ky_noi_bo, file_hd_noi_bo_id, phi, new Date().toISOString(), id);
  }
  db.prepare('UPDATE missions SET status = ?, start_date = ? WHERE id = ?').run('dang_thuc_hien', ngay_ky_ngoai, id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Đã ký hợp đồng — bắt đầu thực hiện: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> đã ký hợp đồng — bắt đầu thực hiện.</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã xác nhận ký hợp đồng. Đề tài bắt đầu thực hiện.', status: 'dang_thuc_hien' });
});

// Danh sách đề tài chờ CT HĐ xét duyệt (Bước 3)
app.get('/api/missions/cho-ct-hd-xet-duyet', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'chu_tich') {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng KHCN hoặc Admin mới xem được' });
  }
  const rows = db.prepare('SELECT id, code, title, principal, level, buoc3_ngay_gui, buoc3_trang_thai FROM missions WHERE status = ? AND (buoc3_trang_thai = ? OR buoc3_trang_thai IS NULL) ORDER BY buoc3_ngay_gui DESC').all('cho_ct_hd_xet_duyet', 'cho_xet_duyet');
  return res.json({ missions: rows });
});

// Admin: cập nhật nhiệm vụ (đề tài)
app.put('/api/admin/missions/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề tài.' });
  const { code, title, principal, principal_hoc_vi, principal_don_vi, principal_orcid, level, status, start_date, end_date, progress, budget, managing_agency, contract_number, funding_source, approved_budget, disbursed_budget, disbursement_year, cooperating_units } = req.body || {};
  const validStatus = ['planning', 'approved', 'ongoing', 'review', 'completed', 'overdue', 'cho_phe_duyet_ngoai', 'da_phe_duyet', 'dang_thuc_hien', 'nghiem_thu_trung_gian', 'nghiem_thu_tong_ket', 'hoan_thanh', 'khong_duoc_phe_duyet', 'cho_vien_xet_chon', 'cho_ct_hd_xet_duyet', 'buoc4a', 'buoc4b', 'cho_bo_tham_dinh', 'cho_ngoai_xet_chon', 'cho_phe_duyet_chinh_thuc', 'cho_ky_hop_dong', 'xin_dieu_chinh', 'cho_nghiem_thu_co_so', 'cho_nghiem_thu_bo_nn', 'hoan_thien_sau_nghiem_thu', 'thanh_ly_hop_dong', 'dung_khong_dat_dot'];
  const updates = [];
  const params = [];
  if (code != null && String(code).trim()) { updates.push('code = ?'); params.push(String(code).trim()); }
  if (title != null) { updates.push('title = ?'); params.push(String(title).trim()); }
  if (principal !== undefined) { updates.push('principal = ?'); params.push(principal != null ? String(principal).trim() : null); }
  if (principal_hoc_vi !== undefined) { try { updates.push('principal_hoc_vi = ?'); params.push(principal_hoc_vi != null ? String(principal_hoc_vi).trim() : null); } catch (e) {} }
  if (principal_don_vi !== undefined) { try { updates.push('principal_don_vi = ?'); params.push(principal_don_vi != null ? String(principal_don_vi).trim() : null); } catch (e) {} }
  if (principal_orcid !== undefined) { try { updates.push('principal_orcid = ?'); params.push(principal_orcid != null ? String(principal_orcid).trim() : null); } catch (e) {} }
  if (level != null && ['national', 'ministry', 'university', 'institute'].includes(level)) { updates.push('level = ?'); params.push(level); }
  if (status != null && validStatus.includes(status)) { updates.push('status = ?'); params.push(status); }
  if (start_date != null) { updates.push('start_date = ?'); params.push(String(start_date).trim() || null); }
  if (end_date != null) { updates.push('end_date = ?'); params.push(String(end_date).trim() || null); }
  if (progress != null && !isNaN(parseInt(progress, 10))) { updates.push('progress = ?'); params.push(Math.min(100, Math.max(0, parseInt(progress, 10)))); }
  if (budget !== undefined) { updates.push('budget = ?'); params.push(budget != null && !isNaN(parseFloat(budget)) ? parseFloat(budget) : null); }
  if (managing_agency !== undefined) { updates.push('managing_agency = ?'); params.push((managing_agency || '').trim() || null); }
  if (contract_number !== undefined) { updates.push('contract_number = ?'); params.push((contract_number || '').trim() || null); }
  if (funding_source !== undefined) { updates.push('funding_source = ?'); params.push((funding_source || '').trim() || null); }
  if (approved_budget !== undefined) { updates.push('approved_budget = ?'); params.push(approved_budget != null && !isNaN(parseFloat(approved_budget)) ? parseFloat(approved_budget) : null); }
  if (disbursed_budget !== undefined) { updates.push('disbursed_budget = ?'); params.push(disbursed_budget != null && !isNaN(parseFloat(disbursed_budget)) ? parseFloat(disbursed_budget) : null); }
  if (disbursement_year !== undefined) { updates.push('disbursement_year = ?'); params.push((disbursement_year || '').trim() || null); }
  if (cooperating_units !== undefined) { updates.push('cooperating_units = ?'); params.push((cooperating_units || '').trim() || null); }
  if (updates.length === 0) return res.status(400).json({ message: 'Không có trường nào để cập nhật.' });
  params.push(id);
  db.prepare('UPDATE missions SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
  const updated = db.prepare('SELECT id, code, title, principal, level, status, start_date, end_date, progress, budget FROM missions WHERE id = ?').get(id);
  return res.json({ message: 'Đã cập nhật đề tài.', mission: updated });
});

// Admin: xóa một nhiệm vụ (đề tài) khỏi dashboard
app.delete('/api/admin/missions/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT id, code, source_type, source_id FROM missions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề tài.' });
  db.prepare('DELETE FROM missions WHERE id = ?').run(id);
  if (row.source_type === 'cap_vien' && row.source_id != null) {
    try {
      db.prepare('INSERT OR IGNORE INTO missions_hidden (source_type, source_id) VALUES (?, ?)').run('cap_vien', row.source_id);
    } catch (e) {}
  }
  return res.json({ message: 'Đã xóa đề tài "' + (row.code || '') + '" khỏi danh sách.', deletedId: id });
});

// CSV helper: escape field for CSV (quote if contains comma, newline or quote)
function csvEscape(s) {
  if (s == null) return '';
  const str = String(s).trim();
  if (/[,"\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// Export template CSV: dùng sep=, để Excel mở ra mỗi cột 1 ô (không dồn vào 1 ô)
app.get('/api/missions/export-template', (req, res) => {
  const header = 'code,title,principal,level,status,start_date,end_date,progress,budget';
  const note = 'GHI CHÚ (dòng này bỏ qua khi import): Mỗi dòng = 1 nhiệm vụ. Cấp: national|ministry|university|institute. Trạng thái: planning|cho_vien_xet_chon|cho_bo_tham_dinh|cho_ngoai_xet_chon|cho_phe_duyet_ngoai|da_phe_duyet|cho_ky_hop_dong|dang_thuc_hien|xin_dieu_chinh|cho_nghiem_thu_co_so|nghiem_thu_trung_gian|cho_nghiem_thu_bo_nn|nghiem_thu_tong_ket|hoan_thien_sau_nghiem_thu|thanh_ly_hop_dong|hoan_thanh|khong_duoc_phe_duyet. Ngày: YYYY-MM-DD';
  const sample1 = 'DT-2025-001,Nghiên cứu ứng dụng tế bào gốc trong điều trị,TS. Nguyễn Văn A,institute,ongoing,2025-01-15,2027-12-31,35,500000000';
  const sample2 = 'DT-2025-002,Phát triển công nghệ nuôi cấy tế bào gốc,PGS.TS. Trần Thị B,ministry,approved,2025-03-01,2026-12-31,0,2500000000';
  const sample3 = 'DT-2024-010,Xây dựng ngân hàng tế bào gốc tiêu chuẩn GMP,TS. Lê Văn C,institute,review,2024-06-01,2025-05-31,90,1500000000';
  const csv = '\uFEFFsep=,\n' + header + '\n' + csvEscape(note) + ',,,,,,,\n' + sample1 + '\n' + sample2 + '\n' + sample3 + '\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="mau_nhap_lieu_nhiem_vu_khcn.csv"');
  return res.send(csv);
});

// Export số liệu từ dashboard (Admin)
app.get('/api/missions/export', authMiddleware, adminOnly, (req, res) => {
  syncMissionsFromCapVien();
  const rows = db.prepare('SELECT code, title, principal, level, status, start_date, end_date, progress, budget FROM missions ORDER BY start_date DESC, id DESC').all();
  const header = 'code,title,principal,level,status,start_date,end_date,progress,budget';
  const lines = [header].concat(rows.map(r => [
    csvEscape(r.code),
    csvEscape(r.title),
    csvEscape(r.principal),
    csvEscape(r.level),
    csvEscape(r.status),
    csvEscape(r.start_date),
    csvEscape(r.end_date),
    r.progress != null ? r.progress : '',
    r.budget != null ? r.budget : ''
  ].join(',')));
  const csv = '\uFEFFsep=,\n' + lines.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="so_lieu_nhiem_vu_khcn_' + new Date().toISOString().slice(0, 10) + '.csv"');
  return res.send(csv);
});

// Export Excel (.xlsx) — hỗ trợ tiếng Việt đầy đủ (không bị vỡ font)
app.get('/api/missions/export-excel', authMiddleware, adminOnly, (req, res) => {
  try {
    syncMissionsFromCapVien();
    const rows = db.prepare('SELECT code, title, principal, level, status, start_date, end_date, progress, budget FROM missions ORDER BY start_date DESC, id DESC').all();
    const data = rows.map(r => ({
      code: r.code || '',
      title: r.title || '',
      principal: r.principal || '',
      level: r.level || '',
      status: r.status || '',
      start_date: r.start_date || '',
      end_date: r.end_date || '',
      progress: r.progress != null ? r.progress : '',
      budget: r.budget != null ? r.budget : ''
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Nhiệm vụ KHCN');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = 'so_lieu_nhiem_vu_khcn_' + new Date().toISOString().slice(0, 10) + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    return res.send(buf);
  } catch (err) {
    console.error('[Export Excel]', err);
    return res.status(500).json({ message: 'Lỗi xuất Excel: ' + (err.message || 'Không xác định') });
  }
});

app.get('/api/missions/by-code/:code', (req, res) => {
  const code = (req.params.code || '').trim();
  if (!code) return res.status(400).json({ message: 'Mã đề tài không hợp lệ' });
  syncMissionsFromCapVien();
  const row = db.prepare('SELECT id, code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type, managing_agency, contract_number, funding_source, approved_budget, disbursed_budget, disbursement_year, cooperating_units, mission_type, field, objectives FROM missions WHERE code = ?').get(code);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  return res.json(row);
});

app.get('/api/missions/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  syncMissionsFromCapVien();
  const colsBase = 'id, code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type, managing_agency, contract_number, funding_source, approved_budget, disbursed_budget, disbursement_year, cooperating_units, mission_type, field, objectives, created_at, buoc3_trang_thai, buoc3_nguoi_xet_duyet_id, buoc3_ngay_gui, buoc3_ngay_phan_hoi, buoc3_ket_qua, buoc3_dieu_kien, buoc3_nhan_xet_khoa_hoc, buoc3_nhan_xet_kha_thi, buoc3_nhan_xet_dinh_huong, buoc3_nhan_xet_nang_luc, buoc3_ly_do_tu_choi, buoc3_lan_xet_thu, nhanh, lan_phan_nhanh';
  const cols = colsBase + ', principal_hoc_vi, principal_don_vi, principal_orcid';
  let row;
  try {
    row = db.prepare('SELECT ' + cols + ' FROM missions WHERE id = ?').get(id);
    if (!row && (req.query.code || '').trim()) row = db.prepare('SELECT ' + cols + ' FROM missions WHERE code = ?').get((req.query.code || '').trim());
  } catch (e) {
    row = db.prepare('SELECT ' + colsBase + ' FROM missions WHERE id = ?').get(id);
    if (!row && (req.query.code || '').trim()) row = db.prepare('SELECT ' + colsBase + ' FROM missions WHERE code = ?').get((req.query.code || '').trim());
    if (row) row.principal_hoc_vi = row.principal_don_vi = row.principal_orcid = null;
  }
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  try {
    const lichSu = db.prepare('SELECT id, lan_xet, nguoi_xet_id, ngay_xet, ket_qua, nhan_xet_json, dieu_kien, ly_do_tu_choi FROM lich_su_buoc3 WHERE mission_id = ? ORDER BY lan_xet ASC').all(id);
    row.lich_su_buoc3 = lichSu.map(ls => {
      const reviewer = ls.nguoi_xet_id ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(ls.nguoi_xet_id) : null;
      return {
        lan_xet: ls.lan_xet,
        ngay_xet: ls.ngay_xet,
        nguoi_xet: reviewer ? (reviewer.fullname || reviewer.email || '') : '—',
        ket_qua: ls.ket_qua,
        nhan_xet_json: ls.nhan_xet_json,
        dieu_kien: ls.dieu_kien,
        ly_do_tu_choi: ls.ly_do_tu_choi
      };
    });
  } catch (e) {
    row.lich_su_buoc3 = [];
  }
  try {
    const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
    if (b4a) row.buoc4a = b4a;
  } catch (e) {
    row.buoc4a = null;
  }
  try {
    const b4b = db.prepare('SELECT * FROM buoc4b WHERE mission_id = ?').get(id);
    if (b4b) row.buoc4b = b4b;
  } catch (e) {
    row.buoc4b = null;
  }
  try {
    const b5 = db.prepare('SELECT * FROM buoc5 WHERE mission_id = ?').get(id);
    if (b5) row.buoc5 = b5;
  } catch (e) {
    row.buoc5 = null;
  }
  try {
    const tmLs = db.prepare('SELECT id, file_id, phien_ban, ghi_chu, created_at FROM buoc5_thuyet_minh_ls WHERE mission_id = ? ORDER BY created_at DESC').all(id);
    if (tmLs && tmLs.length > 0) row.buoc5_thuyet_minh_ls = tmLs;
  } catch (e) {
    row.buoc5_thuyet_minh_ls = [];
  }
  try {
    const b6 = db.prepare('SELECT * FROM buoc6 WHERE mission_id = ?').get(id);
    if (b6) row.buoc6 = b6;
  } catch (e) {
    row.buoc6 = null;
  }
  try {
    const doiNhanh = db.prepare('SELECT id, nhanh_cu, nhanh_moi, cap_cu, cap_moi, ly_do, reset_boi, reset_luc, buoc4_snapshot FROM lich_su_doi_nhanh WHERE mission_id = ? ORDER BY reset_luc DESC').all(id);
    row.lich_su_doi_nhanh = doiNhanh.map(d => {
      const u = d.reset_boi ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(d.reset_boi) : null;
      return {
        id: d.id,
        nhanh_cu: d.nhanh_cu,
        nhanh_moi: d.nhanh_moi,
        cap_cu: d.cap_cu,
        cap_moi: d.cap_moi,
        ly_do: d.ly_do,
        reset_boi: u ? (u.fullname || u.email || '') : '—',
        reset_luc: d.reset_luc,
        buoc4_snapshot: d.buoc4_snapshot
      };
    });
  } catch (e) {
    row.lich_su_doi_nhanh = [];
  }
  return res.json(row);
});

// Upload file đăng ký (Thuyết minh chi tiết, Văn bản xin phép Viện trưởng) — missions_files
app.post('/api/missions/:id/files', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!req.file || !req.file.path) return res.status(400).json({ message: 'Vui lòng chọn file để upload' });
  const fieldName = (req.body.field_name || '').trim();
  const allowedFields = ['thuyet_minh_chi_tiet', 'van_ban_xin_phep_vien_truong', 'buoc4a_bien_ban', 'buoc4a_danh_muc', 'buoc4a_van_ban_bo', 'buoc4a_thuyet_minh_chinh_sua', 'buoc4b_tai_lieu', 'buoc5_thuyet_minh', 'buoc5_qd_phe_duyet', 'buoc6_hd_ngoai', 'buoc6_hd_noi_bo'];
  if (!allowedFields.includes(fieldName)) return res.status(400).json({ message: 'field_name không hợp lệ' });
  const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
  const allowedExt = ['pdf', 'doc', 'docx'];
  if (!allowedExt.includes(ext)) return res.status(400).json({ message: 'Chỉ chấp nhận file PDF, Word (.doc, .docx)' });
  const destDir = path.join(__dirname, 'uploads', 'missions', String(id));
  fs.mkdirSync(destDir, { recursive: true });
  const finalName = Date.now() + '_' + (req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const destPath = path.join(destDir, finalName);
  fs.copyFileSync(req.file.path, destPath);
  try { fs.unlinkSync(req.file.path); } catch (_) {}
  const relPath = path.join('missions', String(id), finalName);
  db.prepare('INSERT INTO missions_files (mission_id, field_name, original_name, path) VALUES (?, ?, ?, ?)').run(id, fieldName, req.file.originalname || finalName, relPath);
  const row = db.prepare('SELECT id, field_name, original_name, path, created_at FROM missions_files WHERE id = last_insert_rowid()').get();
  return res.status(201).json({ message: 'Đã lưu file.', file: row });
});

app.get('/api/missions/:id/ho-so-ngoai', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const rows = db.prepare('SELECT id, original_name, path, submission_date, note, created_at FROM missions_ho_so_ngoai WHERE mission_id = ? ORDER BY submission_date DESC, created_at DESC').all(id);
  return res.json({ files: rows });
});

app.post('/api/missions/:id/ho-so-ngoai', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!req.file || !req.file.path) return res.status(400).json({ message: 'Vui lòng chọn file để upload' });
  const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
  const allowed = ['pdf', 'doc', 'docx', 'xls', 'xlsx'];
  if (!allowed.includes(ext)) return res.status(400).json({ message: 'Chỉ chấp nhận file PDF, Word, Excel' });
  const destDir = path.join(__dirname, 'uploads', 'missions', String(id));
  fs.mkdirSync(destDir, { recursive: true });
  const finalName = Date.now() + '_' + (req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const destPath = path.join(destDir, finalName);
  fs.copyFileSync(req.file.path, destPath);
  try { fs.unlinkSync(req.file.path); } catch (_) {}
  const submissionDate = (req.body.submission_date || '').trim() || null;
  const note = (req.body.note || '').trim() || null;
  const relPath = path.join('missions', String(id), finalName);
  db.prepare('INSERT INTO missions_ho_so_ngoai (mission_id, original_name, path, submission_date, note) VALUES (?, ?, ?, ?, ?)'
  ).run(id, req.file.originalname || finalName, relPath, submissionDate, note);
  const row = db.prepare('SELECT id, original_name, path, submission_date, note, created_at FROM missions_ho_so_ngoai WHERE id = last_insert_rowid()').get();
  return res.status(201).json({ message: 'Đã lưu hồ sơ nộp cơ quan ngoài', file: row });
});

app.get('/api/missions/:id/ho-so-ngoai/:fileId/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const row = db.prepare('SELECT id, mission_id, original_name, path FROM missions_ho_so_ngoai WHERE id = ? AND mission_id = ?').get(fileId, id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  const fullPath = path.join(__dirname, 'uploads', row.path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ message: 'File không tồn tại' });
  const safeName = (row.original_name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
  return res.sendFile(fullPath);
});

// Mẫu hồ sơ đăng ký đề tài ngoài Viện — Admin upload, User download
const TEMPLATE_TYPES = ['thuyet_minh_chi_tiet', 'van_ban_xin_phep_vien_truong'];
const TEMPLATE_LABELS = { thuyet_minh_chi_tiet: 'Mẫu Thuyết minh chi tiết', van_ban_xin_phep_vien_truong: 'Mẫu Văn bản xin phép Viện trưởng' };

app.get('/api/missions-templates', (req, res) => {
  const rows = db.prepare('SELECT template_type, original_name, updated_at FROM missions_templates').all();
  return res.json({ templates: rows });
});

app.get('/api/missions-templates/:type/download', (req, res) => {
  const type = (req.params.type || '').trim();
  if (!TEMPLATE_TYPES.includes(type)) return res.status(400).json({ message: 'Loại mẫu không hợp lệ' });
  const row = db.prepare('SELECT template_type, original_name, path FROM missions_templates WHERE template_type = ?').get(type);
  if (!row) return res.status(404).json({ message: 'Chưa có mẫu này' });
  const fullPath = path.join(__dirname, 'uploads', 'templates', row.path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ message: 'File không tồn tại' });
  const safeName = (row.original_name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
  return res.sendFile(fullPath);
});

app.post('/api/admin/missions-templates', authMiddleware, adminOnly, upload.single('file'), (req, res) => {
  const type = (req.body.template_type || '').trim();
  if (!TEMPLATE_TYPES.includes(type)) return res.status(400).json({ message: 'template_type phải là: thuyet_minh_chi_tiet hoặc van_ban_xin_phep_vien_truong' });
  if (!req.file || !req.file.path) return res.status(400).json({ message: 'Vui lòng chọn file để upload' });
  const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
  if (!['pdf', 'doc', 'docx'].includes(ext)) return res.status(400).json({ message: 'Chỉ chấp nhận PDF, Word (.doc, .docx)' });
  const destDir = path.join(__dirname, 'uploads', 'templates');
  fs.mkdirSync(destDir, { recursive: true });
  const finalName = type + '_' + Date.now() + '.' + ext;
  const destPath = path.join(destDir, finalName);
  fs.copyFileSync(req.file.path, destPath);
  try { fs.unlinkSync(req.file.path); } catch (_) {}
  const relPath = finalName;
  db.prepare('INSERT OR REPLACE INTO missions_templates (template_type, original_name, path, updated_at) VALUES (?, ?, ?, datetime(\'now\'))').run(type, req.file.originalname || finalName, relPath);
  const row = db.prepare('SELECT template_type, original_name, updated_at FROM missions_templates WHERE template_type = ?').get(type);
  return res.status(201).json({ message: 'Đã cập nhật mẫu ' + (TEMPLATE_LABELS[type] || type), template: row });
});

// Import CSV hoặc Excel (.xlsx): cập nhật/thêm đề tài vào missions (Admin)
app.post('/api/admin/missions/import', authMiddleware, adminOnly, upload.single('file'), (req, res) => {
  if (!req.file || !req.file.path) {
    return res.status(400).json({ message: 'Vui lòng chọn file CSV hoặc Excel (.xlsx) để import.' });
  }
  const isExcel = (req.file.originalname || '').toLowerCase().endsWith('.xlsx');
  let headerCells = [];
  let dataRows = [];

  if (isExcel) {
    try {
      const buf = fs.readFileSync(req.file.path);
      const workbook = XLSX.read(buf, { type: 'buffer', cellDates: false });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) return res.status(400).json({ message: 'File Excel không có sheet nào.' });
      const sheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      if (!rawRows.length) return res.status(400).json({ message: 'File Excel trống.' });
      headerCells = (rawRows[0] || []).map(c => String(c == null ? '' : c).trim().toLowerCase());
      const startDateCol = headerCells.indexOf('start_date') >= 0 ? headerCells.indexOf('start_date') : -1;
      const endDateCol = headerCells.indexOf('end_date') >= 0 ? headerCells.indexOf('end_date') : -1;
      for (let r = 1; r < rawRows.length; r++) {
        const row = rawRows[r] || [];
        const cells = [];
        for (let c = 0; c < headerCells.length; c++) {
          const val = row[c];
          if (c === startDateCol || c === endDateCol) {
            if (typeof val === 'number' && val >= 1) {
              const d = XLSX.SSF.parse_date_code(val);
              if (d && d.y) cells.push(d.y + '-' + String(d.m).padStart(2, '0') + '-' + String(d.d).padStart(2, '0'));
              else cells.push(String(val == null ? '' : val));
            } else cells.push(String(val == null ? '' : val));
          } else cells.push(String(val == null ? '' : val));
        }
        dataRows.push(cells);
      }
    } catch (e) {
      if (req.file.path && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ message: 'Không đọc được file Excel. Bạn có thể lưu lại dưới dạng CSV (UTF-8) và thử import CSV.' });
    }
  } else {
    let raw = '';
    if (fs.existsSync(req.file.path)) {
      raw = (fs.readFileSync(req.file.path, 'utf8') || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }
    if (!raw || raw.trim().length === 0) {
      return res.status(400).json({ message: 'File trống hoặc không đọc được.' });
    }
    let lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines[0] && lines[0].toLowerCase() === 'sep=,') lines = lines.slice(1);
    let delim = ',';
    if (lines[0] && /^sep=;/i.test(lines[0])) { lines = lines.slice(1); delim = ';'; }
    if (lines.length < 2) {
      return res.status(400).json({ message: 'File CSV cần có ít nhất dòng tiêu đề và một dòng dữ liệu.' });
    }
    const parseRow = (line) => {
      const out = [];
      let inQuoted = false, cur = '';
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (inQuoted && line[i + 1] === '"') { cur += '"'; i++; }
          else inQuoted = !inQuoted;
        } else if (c === delim && !inQuoted) { out.push(cur.trim()); cur = ''; }
        else cur += c;
      }
      out.push(cur.trim());
      return out;
    };
    headerCells = parseRow(lines[0]).map(h => h.trim().toLowerCase());
    for (let i = 1; i < lines.length; i++) dataRows.push(parseRow(lines[i]));
  }

  const codeIdx = headerCells.indexOf('code') >= 0 ? headerCells.indexOf('code') : 0;
  const titleIdx = headerCells.indexOf('title') >= 0 ? headerCells.indexOf('title') : 1;
  const principalIdx = headerCells.indexOf('principal') >= 0 ? headerCells.indexOf('principal') : 2;
  const levelIdx = headerCells.indexOf('level') >= 0 ? headerCells.indexOf('level') : 3;
  const statusIdx = headerCells.indexOf('status') >= 0 ? headerCells.indexOf('status') : 4;
  const startIdx = headerCells.indexOf('start_date') >= 0 ? headerCells.indexOf('start_date') : 5;
  const endIdx = headerCells.indexOf('end_date') >= 0 ? headerCells.indexOf('end_date') : 6;
  const progressIdx = headerCells.indexOf('progress') >= 0 ? headerCells.indexOf('progress') : 7;
  const budgetIdx = headerCells.indexOf('budget') >= 0 ? headerCells.indexOf('budget') : 8;

  const normalizeDate = (s) => {
    if (!s || typeof s !== 'string') return null;
    const v = s.trim();
    if (!v) return null;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) return v.slice(0, 10);
    const parts = v.split(/[/\-.]/).map(p => p.trim());
    if (parts.length >= 3) {
      const a = parseInt(parts[0], 10);
      const b = parseInt(parts[1], 10);
      const c = parseInt(parts[2], 10);
      if (!isNaN(a) && !isNaN(b) && !isNaN(c) && parts[2].length >= 4) {
        let year = c;
        let month = a;
        let day = b;
        if (year < 100) year = 2000 + year;
        if (a > 12 && b <= 12) { month = b; day = a; }
        else if (b > 12 && a <= 12) { month = a; day = b; }
        month = Math.max(1, Math.min(12, month));
        day = Math.max(1, Math.min(31, day));
        return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      }
    }
    return null;
  };

  let inserted = 0;
  let updated = 0;
  const levels = ['national', 'ministry', 'university', 'institute'];
  const statuses = ['planning', 'approved', 'ongoing', 'review', 'completed', 'overdue'];
  for (let i = 0; i < dataRows.length; i++) {
    const cells = dataRows[i];
    if (cells.length < 2) continue;
    const code = (cells[codeIdx] != null ? cells[codeIdx] : cells[0] || '').trim();
    if (!code) continue;
    if (code.length > 80 || code.indexOf('Cấp') >= 0 || code.indexOf('Trạng thái') >= 0 || code.indexOf('GHI CHÚ') >= 0) continue;
    const title = (cells[titleIdx] != null ? cells[titleIdx] : cells[1] || '').trim() || code;
    const principal = (cells[principalIdx] != null ? cells[principalIdx] : '').trim();
    let level = (cells[levelIdx] != null ? cells[levelIdx] : 'institute').trim().toLowerCase();
    if (!levels.includes(level)) level = 'institute';
    let status = (cells[statusIdx] != null ? cells[statusIdx] : 'planning').trim().toLowerCase();
    if (!statuses.includes(status)) status = 'planning';
    const start_date = normalizeDate((cells[startIdx] != null ? cells[startIdx] : '').trim());
    const end_date = normalizeDate((cells[endIdx] != null ? cells[endIdx] : '').trim());
    let progress = parseInt(cells[progressIdx], 10);
    if (isNaN(progress)) progress = 0;
    progress = Math.max(0, Math.min(100, progress));
    let budget = null;
    const b = cells[budgetIdx];
    if (b != null && b.trim() !== '') { const n = parseFloat(String(b).replace(/,/g, '.')); if (!isNaN(n)) budget = n; }
    const existing = db.prepare('SELECT id, source_type FROM missions WHERE code = ?').get(code);
    if (existing) {
      db.prepare(
        'UPDATE missions SET title=?, principal=?, level=?, status=?, start_date=?, end_date=?, progress=?, budget=? WHERE code=?'
      ).run(title, principal, level, status, start_date, end_date, progress, budget, code);
      updated++;
    } else {
      db.prepare(
        'INSERT INTO missions (code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)'
      ).run(code, title, principal, level, status, start_date, end_date, progress, budget);
      inserted++;
    }
  }
  if (req.file.path && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (e) {}
  return res.json({
    message: 'Import xong. Đã thêm ' + inserted + ' đề tài, cập nhật ' + updated + ' đề tài. Dashboard sẽ hiển thị số liệu mới.',
    inserted,
    updated
  });
});

// Admin: cấu hình bật/tắt module trên trang chủ
app.get('/api/admin/homepage-modules', authMiddleware, adminOnly, (req, res) => {
  // Nếu bảng trống thì seed mặc định
  const existing = db.prepare('SELECT code, label, enabled FROM homepage_modules').all();
  if (!existing || existing.length === 0) {
    const stmt = db.prepare('INSERT OR IGNORE INTO homepage_modules (code, label, enabled) VALUES (?, ?, ?)');
    db.transaction(() => {
      HOMEPAGE_MODULES_DEFAULT.forEach(m => {
        stmt.run(m.code, m.label, m.enabled ? 1 : 0);
      });
    })();
  }
  const rows = db.prepare('SELECT code, label, enabled FROM homepage_modules ORDER BY code').all();
  return res.json({ modules: rows });
});

app.put('/api/admin/homepage-modules/:code', authMiddleware, adminOnly, (req, res) => {
  const code = (req.params.code || '').trim();
  if (!code) return res.status(400).json({ message: 'Thiếu mã module' });
  const enabled = req.body && typeof req.body.enabled !== 'undefined' ? !!req.body.enabled : true;
  const labelDefault = (HOMEPAGE_MODULES_DEFAULT.find(m => m.code === code) || {}).label || code;
  db.prepare('INSERT OR IGNORE INTO homepage_modules (code, label, enabled) VALUES (?, ?, ?)')
    .run(code, labelDefault, enabled ? 1 : 0);
  db.prepare('UPDATE homepage_modules SET enabled = ? WHERE code = ?').run(enabled ? 1 : 0, code);
  const row = db.prepare('SELECT code, label, enabled FROM homepage_modules WHERE code = ?').get(code);
  return res.json({ message: 'Đã cập nhật cấu hình module.', module: row });
});

// Public: cấu hình module cho trang chủ (không cần đăng nhập)
app.get('/api/homepage-modules', (req, res) => {
  let rows = db.prepare('SELECT code, enabled FROM homepage_modules').all();
  if (!rows || rows.length === 0) {
    rows = HOMEPAGE_MODULES_DEFAULT.map(m => ({ code: m.code, enabled: m.enabled ? 1 : 0 }));
  }
  return res.json({ modules: rows });
});

// Tiêu chuẩn hệ thống (ISO9001...) — hiển thị trên header trang chủ; Admin có thể sửa/xóa
app.get('/api/settings/standard-label', (req, res) => {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('standard_label');
  const value = (row && row.value != null) ? String(row.value).trim() : null;
  return res.json({ label: value === '' ? '' : (value || 'ISO9001') });
});

app.get('/api/admin/settings/standard-label', authMiddleware, adminOnly, (req, res) => {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('standard_label');
  return res.json({ label: (row && row.value != null) ? String(row.value).trim() : 'ISO9001' });
});

app.put('/api/admin/settings/standard-label', authMiddleware, adminOnly, (req, res) => {
  const label = req.body && req.body.label != null ? String(req.body.label).trim() : '';
  db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run('standard_label', label);
  return res.json({ message: label ? 'Đã lưu tiêu chuẩn hiển thị.' : 'Đã xóa dòng tiêu chuẩn (sẽ không hiển thị trên Trang chủ).', label: label });
});

app.post('/api/admin/notification-recipients', authMiddleware, adminOnly, (req, res) => {
  const { email, fullname } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lòng nhập email' });
  try {
    db.prepare('INSERT INTO notification_recipients (email, fullname) VALUES (?, ?)').run(em, (fullname || '').trim() || null);
    const row = db.prepare('SELECT id, email, fullname, createdAt FROM notification_recipients WHERE email = ?').get(em);
    return res.status(201).json({ message: 'Đã thêm người nhận thông báo.', recipient: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Email này đã có trong danh sách.' });
    return res.status(500).json({ message: 'Lỗi thêm: ' + (e.message || '') });
  }
});

app.delete('/api/admin/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
  try {
    const r = db.prepare('DELETE FROM notification_recipients WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy bản ghi.' });
    return res.json({ message: 'Đã xóa khỏi danh sách nhận thông báo.' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi xóa: ' + (e.message || '') });
  }
});

// ========== Module Hợp tác quốc tế: danh sách email nhận thông báo (đề xuất đoàn ra, đoàn vào, ...) — chỉ Admin ==========
app.get('/api/admin/cooperation/notification-recipients', authMiddleware, adminOnly, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients ORDER BY id').all();
    return res.json({ recipients: rows || [] });
  } catch (e) {
    return res.json({ recipients: [] });
  }
});

app.post('/api/admin/cooperation/notification-recipients', authMiddleware, adminOnly, (req, res) => {
  const { email, fullname, topics, role } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lòng nhập email.' });
  const topicsVal = (topics === 'all' || (typeof topics === 'string' && topics.trim() === 'all')) ? 'all' : (Array.isArray(topics) ? topics.filter(Boolean).join(',') : (typeof topics === 'string' ? topics.trim() : 'all'));
  const roleVal = (role === 'vien_truong' || (typeof role === 'string' && role.trim().toLowerCase() === 'vien_truong')) ? 'vien_truong' : null;
  try {
    db.prepare('INSERT INTO cooperation_notification_recipients (email, fullname, topics, role) VALUES (?, ?, ?, ?)').run(em, (fullname || '').trim() || null, topicsVal || 'all', roleVal);
    const row = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients WHERE email = ?').get(em);
    return res.status(201).json({ message: 'Đã thêm người nhận thông báo.', recipient: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Email này đã có trong danh sách.' });
    return res.status(500).json({ message: 'Lỗi thêm: ' + (e.message || '') });
  }
});

app.delete('/api/admin/cooperation/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  try {
    const r = db.prepare('DELETE FROM cooperation_notification_recipients WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy bản ghi.' });
    return res.json({ message: 'Đã xóa khỏi danh sách nhận thông báo.' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi xóa: ' + (e.message || '') });
  }
});

app.patch('/api/admin/cooperation/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role } = req.body || {};
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const roleVal = (role === 'vien_truong' || (typeof role === 'string' && role.trim().toLowerCase() === 'vien_truong')) ? 'vien_truong' : null;
  try {
    const r = db.prepare('UPDATE cooperation_notification_recipients SET role = ? WHERE id = ?').run(roleVal, id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy bản ghi.' });
    const row = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients WHERE id = ?').get(id);
    return res.json({ message: 'Đã cập nhật.', recipient: row });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Gửi đề xuất Thỏa thuận (MOU): lưu vào DB + gửi email tới danh sách nhận thông báo (topic mou hoặc all)
app.post('/api/cooperation/mou/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const submittedBy = (user.fullname || user.email || 'Người dùng').trim();
  const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
  const body = req.body || {};
  const loaiThoaThuan = (body.loai_thoa_thuan || body.loaiThoaThuan || '').trim() || '—';
  const tenDoiTac = (body.ten_doi_tac || body.tenDoiTac || '').trim() || '—';
  const quocGia = (body.quoc_gia || body.quocGia || '').trim() || '—';
  const thoiHanNam = (body.thoi_han_nam != null && body.thoi_han_nam !== '') ? String(body.thoi_han_nam) : '—';
  const giaTriTaiChinh = (body.gia_tri_tai_chinh || body.giaTriTaiChinh || '').trim() || '—';
  const donViDeXuat = (body.don_vi_de_xuat || body.donViDeXuat || '').trim() || '—';
  const noiDungHopTac = (body.noi_dung_hop_tac || body.noiDungHopTac || '').trim() || '—';
  const { to: toList, cc: ccList } = getCooperationRecipientsSplit('mou');
  const allRecipients = [...toList, ...ccList];
  if (allRecipients.length === 0) {
    return res.status(400).json({
      message: 'Chưa có email nhận thông báo đề xuất Thỏa thuận. Admin vui lòng thêm trong Quản trị Hợp tác Quốc tế → Danh sách email (chọn topic MOU).',
      sent: 0
    });
  }
  try {
    db.prepare(
      `INSERT INTO cooperation_mou_de_xuat (submitted_by_email, submitted_by_name, loai_thoa_thuan, ten_doi_tac, quoc_gia, thoi_han_nam, gia_tri_tai_chinh, don_vi_de_xuat, noi_dung_hop_tac, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dang_tham_dinh')`
    ).run(submittedByEmail, submittedBy, loaiThoaThuan, tenDoiTac, quocGia, thoiHanNam, giaTriTaiChinh, donViDeXuat, noiDungHopTac);
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi lưu đề xuất: ' + (e.message || ''), sent: 0 });
  }
  const subject = '[Hợp tác QT] Đề xuất Thỏa thuận mới: ' + tenDoiTac + ' — ' + submittedBy;
  const textBody = 'Kính gửi Viện trưởng,\n\nPhòng KHCN&QHĐN trân trọng báo cáo: ' + submittedBy + ' (' + submittedByEmail + ') đã gửi đề xuất Thỏa thuận hợp tác quốc tế mới lên Phòng để thẩm định và trình Viện trưởng.\n\nThông tin đề xuất:\n- Loại thỏa thuận: ' + loaiThoaThuan + '\n- Đối tác: ' + tenDoiTac + '\n- Quốc gia: ' + quocGia + '\n- Thời hạn (năm): ' + thoiHanNam + '\n- Giá trị tài chính: ' + giaTriTaiChinh + '\n- Đơn vị đề xuất: ' + donViDeXuat + '\n- Nội dung hợp tác: ' + noiDungHopTac + '\n\nKính mong Viện trưởng xem xét và chỉ đạo. Phòng KHCN&QHĐN sẽ thẩm định và báo cáo chi tiết khi có kết quả.\n\nTrân trọng.';
  const htmlBody = '<p style="margin-bottom:16px;"><strong>Kính gửi Viện trưởng,</strong></p><p>Phòng KHCN&amp;QHĐN trân trọng báo cáo: <strong>' + submittedBy + '</strong> (' + submittedByEmail + ') đã gửi đề xuất Thỏa thuận hợp tác quốc tế mới lên Phòng để thẩm định và trình Viện trưởng.</p><p><strong>Thông tin đề xuất:</strong></p><table border="1" cellpadding="10" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:560px;"><tr style="background:#f8fafc;"><td style="font-weight:600;width:40%;">Loại thỏa thuận</td><td>' + loaiThoaThuan + '</td></tr><tr><td style="font-weight:600;">Đối tác</td><td>' + tenDoiTac + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Quốc gia</td><td>' + quocGia + '</td></tr><tr><td style="font-weight:600;">Thời hạn (năm)</td><td>' + thoiHanNam + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Giá trị tài chính</td><td>' + giaTriTaiChinh + '</td></tr><tr><td style="font-weight:600;">Đơn vị đề xuất</td><td>' + donViDeXuat + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Nội dung hợp tác</td><td>' + noiDungHopTac.replace(/\n/g, '<br>') + '</td></tr></table><p style="margin-top:16px;">Kính mong Viện trưởng xem xét và chỉ đạo. Phòng KHCN&amp;QHĐN sẽ thẩm định và báo cáo chi tiết khi có kết quả.</p><p>Trân trọng.</p>';
  const year = new Date().getFullYear();
  const lastIdMou = db.prepare('SELECT last_insert_rowid() as id').get();
  const maDeXuatMou = 'ĐX-' + year + '-M' + String(lastIdMou.id || 0).padStart(4, '0');
  if (!transporter) {
    return res.json({ message: 'Đã lưu đề xuất. Hệ thống chưa cấu hình SMTP nên chưa gửi được email thông báo.', sent: 0, ma_de_xuat: maDeXuatMou });
  }
  const mailOpts = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toList.length > 0 ? toList.join(', ') : ccList[0],
    subject,
    text: textBody,
    html: htmlBody
  };
  if (ccList.length > 0 && toList.length > 0) mailOpts.cc = ccList.join(', ');
  else if (toList.length === 0 && ccList.length > 1) mailOpts.cc = ccList.slice(1).join(', ');
  transporter.sendMail(mailOpts).then(() => {
    res.json({ message: 'Đã gửi đề xuất Thỏa thuận tới Phòng KHCN&QHĐN. Email đã gửi tới Viện trưởng (Kính gửi) và CC ' + allRecipients.length + ' địa chỉ.', sent: allRecipients.length, ma_de_xuat: maDeXuatMou });
  }).catch(err => {
    console.error('[Email] Gửi thông báo đề xuất MOU lỗi:', err.message);
    res.status(500).json({ message: 'Gửi email thất bại: ' + (err.message || 'Lỗi hệ thống.'), sent: 0 });
  });
});

// Helper: Admin hoặc Viện trưởng (email trong cooperation_notification_recipients với role=vien_truong)
function vienTruongOrAdmin(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role === 'admin') return next();
  const email = (req.user.email || '').trim().toLowerCase();
  if (!email) return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới có quyền này' });
  try {
    const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    if (r) return next();
  } catch (e) {}
  return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới có quyền này' });
}

// Helper: Admin, P.KHCN (users.role) hoặc Viện trưởng — dùng cho mục QUẢN LÝ
function canSeeQuanLySection(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role === 'admin' || role === 'phong_khcn') return next();
  const email = (req.user.email || '').trim().toLowerCase();
  if (!email) return res.status(403).json({ message: 'Chỉ Admin, Phòng KHCN hoặc Viện trưởng mới có quyền này' });
  try {
    const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    if (r) return next();
  } catch (e) {}
  return res.status(403).json({ message: 'Chỉ Admin, Phòng KHCN hoặc Viện trưởng mới có quyền này' });
}

// Chi tiết đề xuất (MOU hoặc Đoàn ra) — user phải là người gửi hoặc admin/vien_truong
app.get('/api/cooperation/de-xuat-chi-tiet/:source/:id', authMiddleware, (req, res) => {
  const source = (req.params.source || '').toLowerCase();
  const id = parseInt(req.params.id, 10);
  if (!id || !['mou', 'doan_ra', 'doan_vao'].includes(source)) {
    return res.status(400).json({ message: 'Nguồn hoặc ID không hợp lệ' });
  }
  const userEmail = (req.user.email || '').trim().toLowerCase();
  const year = new Date().getFullYear();
  try {
    if (source === 'mou') {
      const r = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id = ?').get(id);
      if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
      const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
      if (submitterEmail !== userEmail && req.user.role !== 'admin') {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        if (!vt) return res.status(403).json({ message: 'Không có quyền xem đề xuất này' });
      }
      const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : (r.status || '') === 'yeu_cau_bo_sung' ? 2 : 1);
      return res.json({
        source: 'mou',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Đề xuất MOU — ' + (r.ten_doi_tac || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
        loai_thoa_thuan: r.loai_thoa_thuan,
        ten_doi_tac: r.ten_doi_tac,
        quoc_gia: r.quoc_gia,
        thoi_han_nam: r.thoi_han_nam,
        gia_tri_tai_chinh: r.gia_tri_tai_chinh,
        don_vi_de_xuat: r.don_vi_de_xuat,
        noi_dung_hop_tac: r.noi_dung_hop_tac,
        submitted_by_email: r.submitted_by_email,
        submitted_by_name: r.submitted_by_name,
        status: r.status || 'dang_tham_dinh',
        step,
        ngay_gui: (r.created_at || '').slice(0, 10),
        ngay_cap_nhat: (r.updated_at || '').slice(0, 10),
        nguoi_xu_ly: 'Phòng KHCN&QHĐN'
      });
    }
    if (source === 'doan_ra') {
      const r = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id = ?').get(id);
      if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
      const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
      if (submitterEmail !== userEmail && req.user.role !== 'admin') {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        if (!vt) return res.status(403).json({ message: 'Không có quyền xem đề xuất này' });
      }
      const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : (r.status || '') === 'dang_chuan_bi' ? 2 : 1);
      return res.json({
        source: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn ra — ' + (r.muc_dich || r.quoc_gia || '—'),
        muc_dich: r.muc_dich,
        quoc_gia: r.quoc_gia,
        ngay_di: r.ngay_di,
        ngay_ve: r.ngay_ve,
        thanh_vien: r.thanh_vien,
        nguon_kinh_phi: r.nguon_kinh_phi,
        du_toan: r.du_toan,
        submitted_by_email: r.submitted_by_email,
        submitted_by_name: r.submitted_by_name,
        status: r.status || 'cho_ky_duyet',
        step,
        ngay_gui: (r.created_at || '').slice(0, 10),
        ngay_cap_nhat: (r.updated_at || '').slice(0, 10),
        nguoi_xu_ly: 'Phòng KHCN&QHĐN'
      });
    }
    if (source === 'doan_vao') {
      const r = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id = ?').get(id);
      if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
      const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
      if (submitterEmail !== userEmail && req.user.role !== 'admin') {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        const pk = (req.user.role || '').toLowerCase() === 'phong_khcn';
        if (!vt && !pk) return res.status(403).json({ message: 'Không có quyền xem đề xuất này' });
      }
      const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : 1);
      return res.json({
        source: 'doan_vao',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-V' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn vào — ' + (r.muc_dich || '—') + ' — ' + (r.don_vi_de_xuat || '—'),
        muc_dich: r.muc_dich,
        don_vi_de_xuat: r.don_vi_de_xuat,
        ngay_den: r.ngay_den,
        ngay_roi_di: r.ngay_roi_di,
        thanh_phan_doan: r.thanh_phan_doan,
        noi_dung_lam_viec: r.noi_dung_lam_viec,
        kinh_phi_nguon: r.kinh_phi_nguon,
        ho_tro_visa: r.ho_tro_visa,
        submitted_by_email: r.submitted_by_email,
        submitted_by_name: r.submitted_by_name,
        status: r.status || 'cho_tham_dinh',
        step,
        ngay_gui: (r.created_at || '').slice(0, 10),
        ngay_cap_nhat: (r.updated_at || '').slice(0, 10),
        nguoi_xu_ly: 'Phòng KHCN&QHĐN'
      });
    }
  } catch (e) {
    console.error('[API] de-xuat-chi-tiet error:', e.message);
    return res.status(500).json({ message: 'Lỗi hệ thống' });
  }
  return res.status(400).json({ message: 'Nguồn không hợp lệ' });
});

// Kiểm tra user có quyền phê duyệt đề xuất (Admin hoặc Viện trưởng)
app.get('/api/cooperation/can-approve', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (role === 'admin') return res.json({ canApprove: true });
  const email = (req.user.email || '').trim().toLowerCase();
  if (!email) return res.json({ canApprove: false });
  try {
    const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    return res.json({ canApprove: !!r });
  } catch (e) {
    return res.json({ canApprove: false });
  }
});

// Số lượng đề xuất chờ P.KHCN vs Viện trưởng + quyền xem mục QUẢN LÝ (Admin, P.KHCN, Viện trưởng)
app.get('/api/cooperation/quan-ly-stats', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  const email = (req.user.email || '').trim().toLowerCase();
  let canSeeQuanLy = role === 'admin' || role === 'phong_khcn';
  if (!canSeeQuanLy && email) {
    try {
      const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
      canSeeQuanLy = !!r;
    } catch (e) {}
  }
  let choPhongKhcn = 0, choVienTruong = 0;
  if (canSeeQuanLy) {
    try {
      const m = db.prepare('SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\'').get();
      let mouCount = (m && m.c) || 0;
      let doanVaoCount = 0;
      try {
        const dv = db.prepare('SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_tham_dinh\'').get();
        doanVaoCount = (dv && dv.c) || 0;
      } catch (e) {}
      choPhongKhcn = mouCount + doanVaoCount;
      const d = db.prepare('SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE lower(trim(status)) = \'cho_ky_duyet\'').get();
      const dCount = (d && d.c) || 0;
      let doanVaoVtCount = 0;
      try {
        const dv = db.prepare('SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_ky_duyet\'').get();
        doanVaoVtCount = (dv && dv.c) || 0;
      } catch (e) {}
      let htqtCount = 0;
      try {
        const h = db.prepare('SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE lower(trim(status)) = \'cho_vt_phe_duyet\'').get();
        htqtCount = (h && h.c) || 0;
      } catch (e) {}
      choVienTruong = dCount + doanVaoVtCount + htqtCount;
    } catch (e) {}
  }
  return res.json({ canSeeQuanLy, choPhongKhcn, choVienTruong });
});

// Các đề xuất chờ P.KHCN thẩm định (MOU dang_tham_dinh + Đoàn vào cho_tham_dinh) — Admin, P.KHCN, Viện trưởng
app.get('/api/cooperation/de-xuat-cho-phong-khcn', authMiddleware, canSeeQuanLySection, (req, res) => {
  const year = new Date().getFullYear();
  const list = [];
  try {
    const mous = db.prepare('SELECT id, submitted_by_email, submitted_by_name, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\' ORDER BY created_at ASC').all();
    for (const r of mous || []) {
      list.push({
        source: 'mou',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Đề xuất MOU — ' + (r.ten_doi_tac || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
        submitted_by: r.submitted_by_name || r.submitted_by_email,
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status
      });
    }
    const doanVao = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, don_vi_de_xuat, thanh_phan_doan, status, created_at FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_tham_dinh\' ORDER BY created_at ASC').all();
    for (const r of doanVao || []) {
      list.push({
        source: 'doan_vao',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-V' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn vào — ' + (r.muc_dich || '—') + ' — ' + (r.don_vi_de_xuat || '—'),
        submitted_by: r.submitted_by_name || r.submitted_by_email,
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status
      });
    }
  } catch (e) {
    console.error('[API] de-xuat-cho-phong-khcn error:', e.message);
  }
  list.sort((a, b) => (a.ngay_gui || '').localeCompare(b.ngay_gui || ''));
  return res.json({ list });
});

// Các đề xuất chờ Viện trưởng phê duyệt (Đoàn ra cho_ky_duyet + HTQT cho_vt_phe_duyet) — Admin, Viện trưởng
app.get('/api/cooperation/de-xuat-cho-vien-truong', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const year = new Date().getFullYear();
  const list = [];
  try {
    const doans = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, quoc_gia, status, created_at FROM cooperation_doan_ra WHERE lower(trim(status)) = \'cho_ky_duyet\' ORDER BY created_at ASC').all();
    for (const r of doans || []) {
      list.push({
        source: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn ra — ' + (r.muc_dich || r.quoc_gia || '—'),
        submitted_by: r.submitted_by_name || r.submitted_by_email,
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status
      });
    }
    const doanVao = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, don_vi_de_xuat, thanh_phan_doan, status, created_at FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_ky_duyet\' ORDER BY created_at ASC').all();
    for (const r of doanVao || []) {
      list.push({
        source: 'doan_vao',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-V' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn vào — ' + (r.muc_dich || '—') + ' — ' + (r.don_vi_de_xuat || '—'),
        submitted_by: r.submitted_by_name || r.submitted_by_email,
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status
      });
    }
    addHtqtToChoDuyetList(list, year);
  } catch (e) {
    console.error('[API] de-xuat-cho-vien-truong error:', e.message);
  }
  list.sort((a, b) => (a.ngay_gui || '').localeCompare(b.ngay_gui || ''));
  return res.json({ list });
});

// Các đề xuất chờ duyệt — chỉ Admin và Viện trưởng (tổng hợp, giữ tương thích)
app.get('/api/cooperation/de-xuat-cho-duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const year = new Date().getFullYear();
  const list = [];
  try {
    const mous = db.prepare('SELECT id, submitted_by_email, submitted_by_name, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\' ORDER BY created_at ASC').all();
    for (const r of mous || []) {
      list.push({
        source: 'mou',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Đề xuất MOU — ' + (r.ten_doi_tac || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
        submitted_by: r.submitted_by_name || r.submitted_by_email,
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status
      });
    }
    const doans = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, quoc_gia, status, created_at FROM cooperation_doan_ra WHERE lower(trim(status)) = \'cho_ky_duyet\' ORDER BY created_at ASC').all();
    for (const r of doans || []) {
      list.push({
        source: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn ra — ' + (r.muc_dich || r.quoc_gia || '—'),
        submitted_by: r.submitted_by_name || r.submitted_by_email,
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status
      });
    }
    addHtqtToChoDuyetList(list, year);
  } catch (e) {
    console.error('[API] de-xuat-cho-duyet error:', e.message);
  }
  list.sort((a, b) => (a.ngay_gui || '').localeCompare(b.ngay_gui || ''));
  return res.json({ list });
});

// Thẩm định Đoàn vào (phê duyệt/từ chối) — P.KHCN hoặc Admin — cho Đoàn vào cho_tham_dinh
app.put('/api/cooperation/doan-vao/:id/tham-dinh', authMiddleware, canSeeQuanLySection, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoặc action không hợp lệ. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'cho_ky_duyet' : 'tu_choi';
  try {
    const row = db.prepare('SELECT status FROM cooperation_doan_vao WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if ((row.status || '').toLowerCase() !== 'cho_tham_dinh') {
      return res.status(400).json({ message: 'Chỉ thẩm định được đề xuất đang chờ P.KHCN.' });
    }
    const r = db.prepare('UPDATE cooperation_doan_vao SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    return res.json({ message: action === 'duyet' ? 'Đã phê duyệt đề xuất Đoàn vào. Trình Viện trưởng phê duyệt.' : 'Đã từ chối đề xuất Đoàn vào.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Phê duyệt/Từ chối Đoàn vào — Viện trưởng hoặc Admin — cho Đoàn vào cho_ky_duyet
app.put('/api/cooperation/doan-vao/:id/duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoặc action không hợp lệ. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const row = db.prepare('SELECT status FROM cooperation_doan_vao WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if ((row.status || '').toLowerCase() !== 'cho_ky_duyet') {
      return res.status(400).json({ message: 'Chỉ phê duyệt được đề xuất đang chờ Viện trưởng.' });
    }
    const r = db.prepare('UPDATE cooperation_doan_vao SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    return res.json({ message: action === 'duyet' ? 'Đã phê duyệt đề xuất Đoàn vào.' : 'Đã từ chối đề xuất Đoàn vào.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Thẩm định MOU (phê duyệt/từ chối) — P.KHCN hoặc Admin — cho MOU dang_tham_dinh
app.put('/api/cooperation/mou/:id/tham-dinh', authMiddleware, canSeeQuanLySection, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoặc action không hợp lệ. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const row = db.prepare('SELECT status FROM cooperation_mou_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if ((row.status || '').toLowerCase() !== 'dang_tham_dinh') {
      return res.status(400).json({ message: 'Chỉ thẩm định được đề xuất đang chờ P.KHCN.' });
    }
    const r = db.prepare('UPDATE cooperation_mou_de_xuat SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    return res.json({ message: action === 'duyet' ? 'Đã phê duyệt đề xuất MOU.' : 'Đã từ chối đề xuất MOU.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Phê duyệt/Từ chối MOU — Admin hoặc Viện trưởng
app.put('/api/cooperation/mou/:id/duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoặc action không hợp lệ. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const r = db.prepare('UPDATE cooperation_mou_de_xuat SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    return res.json({ message: action === 'duyet' ? 'Đã phê duyệt đề xuất MOU.' : 'Đã từ chối đề xuất MOU.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Phê duyệt/Từ chối Đoàn ra — Admin hoặc Viện trưởng
app.put('/api/cooperation/doan-ra/:id/duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoặc action không hợp lệ. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const r = db.prepare('UPDATE cooperation_doan_ra SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    return res.json({ message: action === 'duyet' ? 'Đã phê duyệt đề xuất Đoàn ra.' : 'Đã từ chối đề xuất Đoàn ra.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// ========== HTQT ĐỀ XUẤT YTNN (Chương VII Quy chế KHCN-ĐMST SCI 2026) ==========
function canAccessHtqtDeXuat(req, row) {
  const role = (req.user.role || '').toLowerCase();
  const email = (req.user.email || '').trim().toLowerCase();
  if (role === 'admin') return true;
  if (role === 'phong_khcn') return true;
  try {
    const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    if (vt) return true;
  } catch (e) {}
  if (row && row.submitted_by_email && (row.submitted_by_email || '').trim().toLowerCase() === email) return true;
  if (row && row.submitted_by_id === req.user.id) return true;
  return false;
}

function phiQuanLyTheoLoaiHinh(loaiHinh, kinhPhiVnd) {
  const k = (kinhPhiVnd || 0);
  if ((loaiHinh || '').toLowerCase() === 'hoat_dong_khcn') return { pct: 8, vnd: k * 0.08 };
  if ((loaiHinh || '').toLowerCase() === 'dich_vu_khcn') return { pct: 13, vnd: k * 0.13 };
  if ((loaiHinh || '').toLowerCase() === 'tai_tro_vien_tro') return { pct: 3, vnd: k * 0.03 };
  return { pct: 0, vnd: 0 };
}

function deNghiVtTheoLoaiHinh(loaiHinh) {
  const l = (loaiHinh || '').toLowerCase();
  if (l === 'hoat_dong_khcn') return 'Phê duyệt tiếp nhận và giao Phòng KHCN cấp mã dự án (Điều 62, 64)';
  if (l === 'tai_tro_vien_tro') return 'Xác nhận để trình Trường ĐHKHTN phê duyệt (Điều 64)';
  if (l === 'dich_vu_khcn') return 'Phê duyệt triển khai theo quy trình dịch vụ (Điều 64)';
  return 'Phê duyệt theo quy định';
}

// GET Đề xuất YTNN chi tiết — vien_truong, admin, phong_khcn, chu_nhiem
app.get('/api/htqt/de-xuat/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if (!canAccessHtqtDeXuat(req, row)) return res.status(403).json({ message: 'Không có quyền xem đề xuất này' });
    const files = db.prepare('SELECT id, loai_file, ten_file, duong_dan, uploaded_by_id, uploaded_at FROM htqt_de_xuat_files WHERE de_xuat_id = ? ORDER BY id').all(id);
    const history = db.prepare('SELECT id, action, performed_by_name, performed_at, note FROM htqt_de_xuat_history WHERE de_xuat_id = ? ORDER BY performed_at DESC').all(id);
    const phi = phiQuanLyTheoLoaiHinh(row.loai_hinh, row.kinh_phi_vnd);
    const coNgưỡngKinhPhi = (row.kinh_phi_vnd || 0) > 500000000;
    const coNgưỡngThoiGian = (row.thoi_gian_thang || 0) > 60;
    const filesBatBuoc = ['thuyet_minh', 'van_ban_doi_tac', 'ly_lich_cn', 'y_kien_to_phan_loai'];
    const filesCo = (files || []).map(f => (f.loai_file || '').toLowerCase());
    const thieuFile = filesBatBuoc.filter(loai => !filesCo.includes(loai));
    const coThieuHoSo = thieuFile.length > 0;
    const chuaPhanLoai = !row.loai_hinh || !row.loai_hinh.trim();
    const co = { NGƯỠNG_KINH_PHI: coNgưỡngKinhPhi, NGƯỠNG_THOI_GIAN: coNgưỡngThoiGian, CHUA_PHAN_LOAI: chuaPhanLoai, THIEU_HO_SO: coThieuHoSo };
    const canPheDuyet = row.status === 'cho_vt_phe_duyet' && !chuaPhanLoai && !coThieuHoSo;
    const deNghiVt = row.de_nghi_vt || deNghiVtTheoLoaiHinh(row.loai_hinh);
    return res.json({
      ...row,
      files: files || [],
      history: history || [],
      phi_quan_ly: phi,
      co_canh_bao: co,
      can_phe_duyet: canPheDuyet,
      de_nghi_vt: deNghiVt,
      thieu_file: thieuFile
    });
  } catch (e) {
    console.error('[API] htqt/de-xuat error:', e.message);
    return res.status(500).json({ message: 'Lỗi hệ thống' });
  }
});

// POST Phê duyệt — vien_truong hoặc admin
app.post('/api/htqt/de-xuat/:id/phe-duyet', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { y_kien, ngay_ky, so_van_ban } = req.body || {};
  const userEmail = (req.user.email || '').trim().toLowerCase();
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isAdmin) {
    try {
      const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
      if (!vt) return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được phê duyệt' });
    } catch (e) {
      return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được phê duyệt' });
    }
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if ((row.status || '').toLowerCase() !== 'cho_vt_phe_duyet') return res.status(400).json({ message: 'Trạng thái không cho phép phê duyệt' });
    if (!row.loai_hinh) return res.status(400).json({ message: 'Chưa phân loại loại hình' });
    const ngayKy = (ngay_ky || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    db.prepare('UPDATE htqt_de_xuat SET status = \'da_phe_duyet\', vt_y_kien = ?, vt_ngay_ky = ?, vt_so_van_ban = ?, vt_nguoi_ky_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(y_kien || null, ngayKy, so_van_ban || null, req.user.id, id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'phe_duyet', req.user.id, req.user.fullname || req.user.email, y_kien || '');
    return res.json({ message: 'Đã phê duyệt đề xuất.', status: 'da_phe_duyet' });
  } catch (e) {
    console.error('[API] phe-duyet error:', e.message);
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// POST Yêu cầu bổ sung — vien_truong, admin
app.post('/api/htqt/de-xuat/:id/yeu-cau-bo-sung', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { noi_dung, han_bo_sung, gui_den } = req.body || {};
  if (!noi_dung || (noi_dung || '').trim().length < 20) return res.status(400).json({ message: 'Nội dung yêu cầu tối thiểu 20 ký tự' });
  if (!han_bo_sung) return res.status(400).json({ message: 'Hạn bổ sung bắt buộc' });
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    db.prepare('UPDATE htqt_de_xuat SET status = \'yeu_cau_bo_sung\', updated_at = datetime(\'now\') WHERE id = ?').run(id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'yeu_cau_bo_sung', req.user.id, req.user.fullname || req.user.email, noi_dung.trim(), JSON.stringify({ han_bo_sung, gui_den: gui_den || [] }));
    return res.json({ message: 'Đã gửi yêu cầu bổ sung.', status: 'yeu_cau_bo_sung' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// POST Không phê duyệt — vien_truong hoặc admin
app.post('/api/htqt/de-xuat/:id/khong-phe-duyet', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { ly_do } = req.body || {};
  const userEmail = (req.user.email || '').trim().toLowerCase();
  if (!ly_do || (ly_do || '').trim().length < 30) return res.status(400).json({ message: 'Lý do tối thiểu 30 ký tự' });
  if ((req.user.role || '').toLowerCase() !== 'admin') {
    try {
      const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
      if (!vt) return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được thực hiện' });
    } catch (e) {
      return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được thực hiện' });
    }
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    db.prepare('UPDATE htqt_de_xuat SET status = \'khong_phe_duyet\', ly_do_khong_duyet = ?, updated_at = datetime(\'now\') WHERE id = ?').run(ly_do.trim(), id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'khong_phe_duyet', req.user.id, req.user.fullname || req.user.email, ly_do.trim());
    return res.json({ message: 'Đã ghi nhận không phê duyệt.', status: 'khong_phe_duyet' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// PATCH Admin cập nhật — admin only
app.patch('/api/htqt/de-xuat/:id/admin', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { ma_de_xuat, nguoi_phu_trach_id, muc_do_uu_tien, ghi_chu_noi_bo, trang_thai, loai_hinh } = req.body || {};
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
  try {
    const updates = [];
    const params = [];
    if (ma_de_xuat != null) { updates.push('ma_de_xuat = ?'); params.push(ma_de_xuat); }
    if (nguoi_phu_trach_id != null) { updates.push('nguoi_phu_trach_id = ?'); params.push(nguoi_phu_trach_id); }
    if (muc_do_uu_tien != null) { updates.push('muc_do_uu_tien = ?'); params.push(muc_do_uu_tien); }
    if (ghi_chu_noi_bo != null) { updates.push('ghi_chu_noi_bo = ?'); params.push(ghi_chu_noi_bo); }
    if (trang_thai != null) { updates.push('status = ?'); params.push(trang_thai); }
    if (loai_hinh != null) { updates.push('loai_hinh = ?'); params.push(loai_hinh); }
    if (updates.length === 0) return res.status(400).json({ message: 'Không có trường nào cập nhật' });
    params.push(id);
    db.prepare('UPDATE htqt_de_xuat SET ' + updates.join(', ') + ', updated_at = datetime(\'now\') WHERE id = ?').run(...params);
    return res.json({ message: 'Đã cập nhật.' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// POST Tạo đề xuất YTNN (demo / Phòng KHCN) — để có dữ liệu test
app.post('/api/htqt/de-xuat', authMiddleware, (req, res) => {
  const user = req.user || {};
  const body = req.body || {};
  const year = new Date().getFullYear();
  try {
    db.prepare(`
      INSERT INTO htqt_de_xuat (ten, mo_ta, doi_tac_ten, doi_tac_quoc_gia, chu_nhiem_ten, chu_nhiem_hoc_vi, chu_nhiem_don_vi,
        ngay_bat_dau, ngay_ket_thuc, thoi_gian_thang, kinh_phi_vnd, loai_hinh, to_trinh_phong_khcn, status, ngay_tiep_nhan, han_xu_ly_vt,
        submitted_by_email, submitted_by_name, submitted_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.ten || 'Đề xuất tiếp nhận tài chính YTNN mẫu',
      body.mo_ta || 'Mô tả tóm tắt đề xuất hợp tác quốc tế.',
      body.doi_tac_ten || 'Đại học Kyoto',
      body.doi_tac_quoc_gia || 'Nhật Bản',
      body.chu_nhiem_ten || user.fullname || 'Chủ nhiệm',
      body.chu_nhiem_hoc_vi || 'TS.',
      body.chu_nhiem_don_vi || 'Phòng Lab',
      body.ngay_bat_dau || (year + '-04-01'),
      body.ngay_ket_thuc || (year + '-12-31'),
      body.thoi_gian_thang || 9,
      body.kinh_phi_vnd || 300000000,
      body.loai_hinh || 'hoat_dong_khcn',
      body.to_trinh_phong_khcn || 'Phòng KHCN&QHĐN đề nghị Viện trưởng xem xét phê duyệt đề xuất tiếp nhận tài chính YTNN theo Điều 62, 63, 64 Quy chế KHCN-ĐMST SCI 2026.',
      body.status || 'cho_vt_phe_duyet',
      body.ngay_tiep_nhan || new Date().toISOString().slice(0, 10),
      body.han_xu_ly_vt || (() => { const d = new Date(); d.setDate(d.getDate() + 5); return d.toISOString().slice(0, 10); })(),
      user.email || '',
      user.fullname || '',
      user.id || null
    );
    const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
    const ma = body.ma_de_xuat || ('ĐX-' + year + '-' + String(id).padStart(4, '0'));
    db.prepare('UPDATE htqt_de_xuat SET ma_de_xuat = ? WHERE id = ?').run(ma, id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'tao_moi', user.id, user.fullname || user.email, 'Tạo đề xuất');
    ['thuyet_minh', 'van_ban_doi_tac', 'ly_lich_cn', 'y_kien_to_phan_loai'].forEach(function(loai) {
      try {
        db.prepare('INSERT INTO htqt_de_xuat_files (de_xuat_id, loai_file, ten_file, uploaded_by_id) VALUES (?, ?, ?, ?)')
          .run(id, loai, loai.replace(/_/g, ' ') + '.pdf', user.id);
      } catch (e) {}
    });
    return res.json({ message: 'Đã tạo đề xuất.', id, ma_de_xuat: ma });
  } catch (e) {
    console.error('[API] htqt/de-xuat create error:', e.message);
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Thêm htqt_de_xuat vào danh sách chờ duyệt
function addHtqtToChoDuyetList(list, year) {
  try {
    const rows = db.prepare('SELECT id, ten, chu_nhiem_ten, loai_hinh, status, created_at, ngay_tiep_nhan FROM htqt_de_xuat WHERE lower(trim(status)) = \'cho_vt_phe_duyet\' ORDER BY created_at ASC').all();
    for (const r of rows || []) {
      list.push({
        source: 'htqt',
        id: r.id,
        ma_de_xuat: r.ma_de_xuat || ('ĐX-' + year + '-' + String(r.id).padStart(4, '0')),
        title: (r.ten || '—') + (r.chu_nhiem_ten ? ' — ' + r.chu_nhiem_ten : ''),
        submitted_by: r.chu_nhiem_ten || '—',
        ngay_gui: (r.ngay_tiep_nhan || r.created_at || '').slice(0, 10),
        status: r.status,
        loai_hinh: r.loai_hinh
      });
    }
  } catch (e) {}
}

// Đề xuất của tôi — danh sách đề xuất user đã gửi (MOU, Đoàn ra)
app.get('/api/cooperation/de-xuat-cua-toi', authMiddleware, (req, res) => {
  const user = req.user || {};
  const email = (user.email || '').trim().toLowerCase();
  if (!email) return res.json({ list: [], cho_duyet: 0 });
  const year = new Date().getFullYear();
  const list = [];
  try {
    const mous = db.prepare('SELECT id, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
    for (const r of mous || []) {
      list.push({
        source: 'mou',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Đề xuất MOU — ' + (r.ten_doi_tac || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status || 'dang_tham_dinh',
        step: r.status === 'dang_tham_dinh' ? 1 : (r.status === 'da_duyet' ? 4 : 2),
        yeu_cau_bo_sung: null,
        han_phan_hoi: null,
        nguoi_xu_ly: 'Phòng KHCN&QHĐN'
      });
    }
    const doans = db.prepare('SELECT id, muc_dich, quoc_gia, thanh_vien, status, created_at FROM cooperation_doan_ra WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
    for (const r of doans || []) {
      const soTV = (r.thanh_vien || '').split(/\n/).filter(s => s.trim()).length || 1;
      list.push({
        source: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn ra — ' + (r.muc_dich || r.quoc_gia || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : '') + ' — ' + soTV + ' thành viên',
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status || 'cho_ky_duyet',
        step: r.status === 'da_duyet' ? 4 : (r.status === 'tu_choi' ? 4 : r.status === 'dang_chuan_bi' ? 2 : 1),
        yeu_cau_bo_sung: null,
        han_phan_hoi: null,
        nguoi_xu_ly: 'Phòng KHCN&QHĐN'
      });
    }
    try {
      const doanVao = db.prepare('SELECT id, muc_dich, don_vi_de_xuat, thanh_phan_doan, status, created_at FROM cooperation_doan_vao WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
      for (const r of doanVao || []) {
        const st = (r.status || 'cho_tham_dinh').toLowerCase();
        const step = st === 'da_duyet' || st === 'tu_choi' ? 4 : (st === 'cho_ky_duyet' ? 3 : 2);
        list.push({
          source: 'doan_vao',
          id: r.id,
          ma_de_xuat: 'ĐX-' + year + '-V' + String(r.id).padStart(4, '0'),
          title: 'Đăng ký Đoàn vào — ' + (r.muc_dich || '—') + ' — ' + (r.don_vi_de_xuat || '—'),
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status || 'cho_tham_dinh',
          step,
          yeu_cau_bo_sung: null,
          han_phan_hoi: null,
          nguoi_xu_ly: 'Phòng KHCN&QHĐN'
        });
      }
    } catch (ev) {}
  } catch (e) {
    console.error('[API] de-xuat-cua-toi error:', e.message);
  }
  list.sort((a, b) => (b.ngay_gui || '').localeCompare(a.ngay_gui || ''));
  const choDuyet = list.filter(x => ['dang_tham_dinh', 'cho_ky_duyet', 'cho_tham_dinh'].includes((x.status || '').toLowerCase())).length;
  return res.json({ list, cho_duyet: choDuyet });
});

// Gửi đề xuất Đoàn ra: lưu vào DB + gửi email tới danh sách nhận thông báo (topic doan_ra hoặc all)
app.post('/api/cooperation/doan-ra/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const submittedBy = (user.fullname || user.email || 'Người dùng').trim();
  const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
  const body = req.body || {};
  const mucDich = (body.muc_dich || body.mucDich || '').trim() || '—';
  const quocGia = (body.quoc_gia || body.quocGia || '').trim() || '—';
  const ngayDi = (body.ngay_di || body.ngayDi || '').trim() || '—';
  const ngayVe = (body.ngay_ve || body.ngayVe || '').trim() || '—';
  const thanhVien = (body.thanh_vien || body.thanhVien || '').trim() || '—';
  const nguonKinhPhi = (body.nguon_kinh_phi || body.nguonKinhPhi || '').trim() || '—';
  const duToan = (body.du_toan != null && body.du_toan !== '') ? String(body.du_toan) : '—';
  const toList = getCooperationRecipients('doan_ra');
  if (toList.length === 0) {
    return res.status(400).json({
      message: 'Chưa có email nhận thông báo Đoàn ra. Admin vui lòng thêm trong Quản trị module Hợp tác Quốc tế.',
      sent: 0
    });
  }
  try {
    db.prepare(
      `INSERT INTO cooperation_doan_ra (submitted_by_email, submitted_by_name, muc_dich, quoc_gia, ngay_di, ngay_ve, thanh_vien, nguon_kinh_phi, du_toan, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cho_ky_duyet')`
    ).run(submittedByEmail, submittedBy, mucDich, quocGia, ngayDi, ngayVe, thanhVien, nguonKinhPhi, duToan);
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi lưu đề xuất: ' + (e.message || ''), sent: 0 });
  }
  const subject = '[Hợp tác QT] Đề xuất Đoàn ra: ' + quocGia + ' — ' + submittedBy;
  const textBody = submittedBy + ' (' + submittedByEmail + ') vừa gửi đề xuất Đoàn ra.\n\nMục đích: ' + mucDich + '\nĐịa điểm: ' + quocGia + '\nNgày đi: ' + ngayDi + '\nNgày về: ' + ngayVe + '\nThành viên: ' + thanhVien + '\nNguồn kinh phí: ' + nguonKinhPhi + '\nDự toán (USD): ' + duToan;
  const htmlBody = '<p><strong>' + submittedBy + '</strong> (' + submittedByEmail + ') vừa gửi đề xuất <strong>Đoàn ra</strong> lên Phòng KHCN&amp;QHĐN.</p><table border="1" cellpadding="8" style="border-collapse:collapse;"><tr><td>Mục đích</td><td>' + mucDich + '</td></tr><tr><td>Quốc gia / Địa điểm</td><td>' + quocGia + '</td></tr><tr><td>Ngày đi</td><td>' + ngayDi + '</td></tr><tr><td>Ngày về</td><td>' + ngayVe + '</td></tr><tr><td>Thành viên đoàn</td><td>' + thanhVien.replace(/\n/g, '<br>') + '</td></tr><tr><td>Nguồn kinh phí</td><td>' + nguonKinhPhi + '</td></tr><tr><td>Dự toán (USD)</td><td>' + duToan + '</td></tr></table><p>Vui lòng đăng nhập hệ thống để xem chi tiết và xử lý.</p>';
  const lastId = db.prepare('SELECT last_insert_rowid() as id').get();
  const year = new Date().getFullYear();
  const maDeXuat = 'ĐX-' + year + '-D' + String(lastId.id || 0).padStart(4, '0');
  if (!transporter) {
    return res.json({ message: 'Đã lưu đề xuất. Hệ thống chưa cấu hình SMTP nên chưa gửi được email thông báo.', sent: 0, ma_de_xuat: maDeXuat });
  }
  transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toList.join(', '),
    subject,
    text: textBody,
    html: htmlBody
  }).then(() => {
    res.json({ message: 'Đã gửi đề xuất Đoàn ra tới Phòng KHCN&QHĐN. Email thông báo đã gửi tới ' + toList.length + ' địa chỉ.', sent: toList.length, ma_de_xuat: maDeXuat });
  }).catch(err => {
    console.error('[Email] Gửi thông báo Đoàn ra lỗi:', err.message);
    res.status(500).json({ message: 'Gửi email thất bại: ' + (err.message || 'Lỗi hệ thống.'), sent: 0 });
  });
});

// Gửi đề xuất Đoàn vào: lưu vào DB + gửi email tới danh sách nhận thông báo (topic doan_vao hoặc all)
app.post('/api/cooperation/doan-vao/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const submittedBy = (user.fullname || user.email || 'Người dùng').trim();
  const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
  const body = req.body || {};
  const mucDich = (body.muc_dich || body.mucDich || '').trim() || '—';
  const donViDeXuat = (body.don_vi_de_xuat || body.donViDeXuat || '').trim() || '—';
  const ngayDen = (body.ngay_den || body.ngayDen || '').trim() || '—';
  const ngayRoiDi = (body.ngay_roi_di || body.ngayRoiDi || '').trim() || '—';
  const thanhPhanDoan = (body.thanh_phan_doan || body.thanhPhanDoan || '').trim() || '—';
  const noiDungLamViec = (body.noi_dung_lam_viec || body.noiDungLamViec || '').trim() || '—';
  const kinhPhiNguon = (body.kinh_phi_nguon || body.kinhPhiNguon || '').trim() || '—';
  const hoTroVisa = (body.ho_tro_visa || body.hoTroVisa || '').trim() || '—';
  const toList = getCooperationRecipients('doan_vao');
  if (toList.length === 0) {
    return res.status(400).json({
      message: 'Chưa có email nhận thông báo Đoàn vào. Admin vui lòng thêm trong Quản trị Hợp tác Quốc tế → Danh sách email (chọn topic Đoàn vào).',
      sent: 0
    });
  }
  try {
    db.prepare(
      `INSERT INTO cooperation_doan_vao (submitted_by_email, submitted_by_name, muc_dich, don_vi_de_xuat, ngay_den, ngay_roi_di, thanh_phan_doan, noi_dung_lam_viec, kinh_phi_nguon, ho_tro_visa, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cho_tham_dinh')`
    ).run(submittedByEmail, submittedBy, mucDich, donViDeXuat, ngayDen, ngayRoiDi, thanhPhanDoan, noiDungLamViec, kinhPhiNguon, hoTroVisa);
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi lưu đề xuất: ' + (e.message || ''), sent: 0 });
  }
  const subject = '[Hợp tác QT] Đề xuất Đoàn vào: ' + thanhPhanDoan.slice(0, 50) + (thanhPhanDoan.length > 50 ? '...' : '') + ' — ' + submittedBy;
  const textBody = 'Kính gửi Phòng KHCN&QHĐN,\n\n' + submittedBy + ' (' + submittedByEmail + ') đã gửi đề xuất tiếp nhận Đoàn vào lên Phòng để thẩm định và trình Viện trưởng phê duyệt chủ trương.\n\nThông tin đề xuất:\n- Mục đích chuyến thăm: ' + mucDich + '\n- Đơn vị đề xuất tiếp nhận: ' + donViDeXuat + '\n- Ngày đến: ' + ngayDen + '\n- Ngày rời đi: ' + ngayRoiDi + '\n- Thành phần đoàn khách: ' + thanhPhanDoan + '\n- Nội dung làm việc: ' + noiDungLamViec + '\n- Kinh phí đón tiếp: ' + kinhPhiNguon + '\n- Hỗ trợ visa/nhập cảnh: ' + hoTroVisa + '\n\nVui lòng đăng nhập hệ thống để xem chi tiết và xử lý.\n\nTrân trọng.';
  const htmlBody = '<p style="margin-bottom:16px;"><strong>Kính gửi Phòng KHCN&amp;QHĐN,</strong></p><p>' + submittedBy + ' (' + submittedByEmail + ') đã gửi đề xuất tiếp nhận <strong>Đoàn vào</strong> lên Phòng để thẩm định và trình Viện trưởng phê duyệt chủ trương.</p><p><strong>Thông tin đề xuất:</strong></p><table border="1" cellpadding="8" style="border-collapse:collapse;"><tr><td>Mục đích chuyến thăm</td><td>' + mucDich + '</td></tr><tr><td>Đơn vị đề xuất</td><td>' + donViDeXuat + '</td></tr><tr><td>Ngày đến</td><td>' + ngayDen + '</td></tr><tr><td>Ngày rời đi</td><td>' + ngayRoiDi + '</td></tr><tr><td>Thành phần đoàn khách</td><td>' + thanhPhanDoan.replace(/\n/g, '<br>') + '</td></tr><tr><td>Nội dung làm việc</td><td>' + noiDungLamViec.replace(/\n/g, '<br>') + '</td></tr><tr><td>Kinh phí đón tiếp</td><td>' + kinhPhiNguon + '</td></tr><tr><td>Hỗ trợ visa/nhập cảnh</td><td>' + hoTroVisa + '</td></tr></table><p>Vui lòng đăng nhập hệ thống để xem chi tiết và xử lý.</p><p>Trân trọng.</p>';
  const lastId = db.prepare('SELECT last_insert_rowid() as id').get();
  const year = new Date().getFullYear();
  const maDeXuat = 'ĐX-' + year + '-V' + String(lastId.id || 0).padStart(4, '0');
  if (!transporter) {
    return res.json({ message: 'Đã lưu đề xuất. Hệ thống chưa cấu hình SMTP nên chưa gửi được email thông báo.', sent: 0, ma_de_xuat: maDeXuat });
  }
  transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toList.join(', '),
    subject,
    text: textBody,
    html: htmlBody
  }).then(() => {
    res.json({ message: 'Đã gửi đề xuất Đoàn vào tới Phòng KHCN&QHĐN. Email thông báo đã gửi tới ' + toList.length + ' địa chỉ.', sent: toList.length, ma_de_xuat: maDeXuat });
  }).catch(err => {
    console.error('[Email] Gửi thông báo Đoàn vào lỗi:', err.message);
    res.status(500).json({ message: 'Gửi email thất bại: ' + (err.message || 'Lỗi hệ thống.'), sent: 0 });
  });
});

// Danh sách đề xuất Đoàn ra (dữ liệu thật, quá trình xử lý)
app.get('/api/cooperation/doan-ra', (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT id, submitted_by_email, submitted_by_name, muc_dich, quoc_gia, ngay_di, ngay_ve, thanh_vien, nguon_kinh_phi, du_toan, status, created_at FROM cooperation_doan_ra ORDER BY created_at DESC`
    ).all();
    return res.json({ list: rows || [] });
  } catch (e) {
    return res.json({ list: [] });
  }
});

// Admin: cập nhật trạng thái đề xuất Đoàn ra (quá trình xử lý)
app.put('/api/admin/cooperation/doan-ra/:id/status', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = (req.body && req.body.status) ? String(req.body.status).trim() : '';
  const allowed = ['cho_ky_duyet', 'dang_chuan_bi', 'da_duyet', 'tu_choi'];
  if (!id || !allowed.includes(status)) {
    return res.status(400).json({ message: 'ID hoặc trạng thái không hợp lệ. Trạng thái: cho_ky_duyet | dang_chuan_bi | da_duyet | tu_choi' });
  }
  try {
    const r = db.prepare('UPDATE cooperation_doan_ra SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
    return res.json({ message: 'Đã cập nhật trạng thái.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Tổng quan Hợp tác Quốc tế — số liệu thật cho dashboard
app.get('/api/cooperation/overview', (req, res) => {
  try {
    const thoaThuans = db.prepare('SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia FROM cooperation_thoa_thuan').all();
    const mouDeXuats = db.prepare('SELECT id, ten_doi_tac, quoc_gia, created_at FROM cooperation_mou_de_xuat').all();
    const doanRa = db.prepare('SELECT id, muc_dich, quoc_gia, thanh_vien, ngay_di, ngay_ve, status, created_at FROM cooperation_doan_ra').all();
    let missions = [];
    try {
      missions = db.prepare('SELECT id, code, title, status, end_date, approved_budget, cooperating_units FROM missions').all();
    } catch (e) {}
    const mouHieuLuc = (thoaThuans || []).filter(r => (r.trang_thai || '').toLowerCase() === 'hieu_luc').length;
    const mouSapHetHan = (thoaThuans || []).filter(r => (r.trang_thai || '').toLowerCase() === 'sap_het_han').length;
    const deXuatChoDuyet = (mouDeXuats || []).length + (doanRa || []).filter(r => (r.status || '').toLowerCase() === 'cho_ky_duyet').length;
    const deTaiDangChay = (missions || []).filter(m => ['ongoing', 'approved', 'implementation'].includes((m.status || '').toLowerCase())).length;
    const deTaiChoDuyet = (missions || []).filter(m => ['planning', 'submitted'].includes((m.status || '').toLowerCase())).length;
    let tongKinhPhi = 0;
    try {
      const r = db.prepare('SELECT COALESCE(SUM(approved_budget), 0) AS s FROM missions WHERE approved_budget IS NOT NULL AND approved_budget > 0').get();
      tongKinhPhi = (r && r.s) ? r.s : 0;
    } catch (e) {}
    const partnerMap = new Map();
    for (const r of thoaThuans || []) {
      const k = (r.doi_tac || '').trim().toLowerCase();
      if (k) partnerMap.set(k, true);
    }
    for (const r of mouDeXuats || []) {
      const k = (r.ten_doi_tac || '').trim().toLowerCase();
      if (k) partnerMap.set(k, true);
    }
    const countries = new Set();
    for (const r of thoaThuans || []) { if (r.quoc_gia) countries.add((r.quoc_gia || '').trim()); }
    for (const r of mouDeXuats || []) { if (r.quoc_gia) countries.add((r.quoc_gia || '').trim()); }
    const pendingItems = [];
    for (const r of (thoaThuans || []).filter(x => (x.trang_thai || '').toLowerCase() === 'sap_het_han')) {
      pendingItems.push({
        type: 'mou',
        typeLabel: 'MOU',
        title: r.ten || (r.doi_tac + ' sắp hết hạn'),
        deadline: r.het_han || '—',
        status: 'sap_het_han',
        statusLabel: 'Sắp hết hạn',
        action: 'thoathuan'
      });
    }
    for (const r of (doanRa || []).filter(x => (x.status || '').toLowerCase() === 'cho_ky_duyet')) {
      const soTV = (r.thanh_vien || '').split(/\n/).filter(s => s.trim()).length || 1;
      pendingItems.push({
        type: 'doan_ra',
        typeLabel: 'Đoàn ra',
        title: (r.muc_dich || r.quoc_gia || 'Đoàn ra') + ' — ' + soTV + ' thành viên',
        deadline: r.ngay_di || '—',
        status: 'cho_ky_duyet',
        statusLabel: 'Chờ ký duyệt',
        action: 'doan-ra',
        source: 'doan_ra',
        id: r.id
      });
    }
    for (const r of mouDeXuats || []) {
      pendingItems.push({
        type: 'mou_de_xuat',
        typeLabel: 'Đề xuất MOU',
        title: 'MOU với ' + (r.ten_doi_tac || '—'),
        deadline: '—',
        status: 'dang_tham_dinh',
        statusLabel: 'Đang thẩm định',
        action: 'thoathuan',
        source: 'mou',
        id: r.id
      });
    }
    try {
      const htqtRows = db.prepare('SELECT id, ten, chu_nhiem_ten, status, han_xu_ly_vt FROM htqt_de_xuat WHERE lower(trim(status)) = \'cho_vt_phe_duyet\'').all();
      for (const r of htqtRows || []) {
        pendingItems.push({
          type: 'de_tai_yttn',
          typeLabel: 'Đề xuất YTNN',
          title: (r.ten || '—') + (r.chu_nhiem_ten ? ' — ' + r.chu_nhiem_ten : ''),
          deadline: r.han_xu_ly_vt || '—',
          status: 'cho_vt_phe_duyet',
          statusLabel: 'Chờ phê duyệt',
          action: 'de-xuat-cho-duyet',
          source: 'htqt',
          id: r.id
        });
      }
    } catch (e) {}
    pendingItems.sort((a, b) => {
      if (a.deadline === '—' && b.deadline === '—') return 0;
      if (a.deadline === '—') return 1;
      if (b.deadline === '—') return -1;
      return String(a.deadline).localeCompare(String(b.deadline));
    });
    const formatTongKinhPhi = (v) => {
      if (v >= 1e9) return (v / 1e9).toFixed(1) + ' tỷ';
      if (v >= 1e6) return (v / 1e6).toFixed(0) + ' triệu';
      return v ? String(Math.round(v)) : '—';
    };
    return res.json({
      stats: {
        total_doi_tac: partnerMap.size,
        mou_hieu_luc: mouHieuLuc,
        mou_sap_het_han: mouSapHetHan,
        de_tai_dang_chay: deTaiDangChay,
        de_tai_cho_duyet: deTaiChoDuyet,
        de_xuat_cho_duyet: deXuatChoDuyet,
        tong_kinh_phi: tongKinhPhi,
        tong_kinh_phi_formatted: formatTongKinhPhi(tongKinhPhi),
        so_quoc_gia: countries.size
      },
      pending_items: pendingItems.slice(0, 10)
    });
  } catch (e) {
    console.error('[API] cooperation/overview error:', e.message);
    return res.json({
      stats: { total_doi_tac: 0, mou_hieu_luc: 0, mou_sap_het_han: 0, de_tai_dang_chay: 0, de_tai_cho_duyet: 0, de_xuat_cho_duyet: 0, tong_kinh_phi: 0, tong_kinh_phi_formatted: '—', so_quoc_gia: 0 },
      pending_items: []
    });
  }
});

// Danh sách Đối tác Quốc tế — tổng hợp từ thỏa thuận, đề xuất MOU, dự án (missions)
app.get('/api/cooperation/doi-tac', (req, res) => {
  try {
    const thoaThuans = db.prepare('SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac FROM cooperation_thoa_thuan').all();
    const mouDeXuats = db.prepare('SELECT id, ten_doi_tac, quoc_gia, loai_thoa_thuan, status FROM cooperation_mou_de_xuat').all();
    let missions = [];
    try {
      missions = db.prepare('SELECT id, cooperating_units, status FROM missions WHERE cooperating_units IS NOT NULL AND cooperating_units != \'\'').all();
    } catch (e) { /* bảng missions có thể chưa có cột */ }
    const partnerMap = new Map();
    const normalize = (s) => (s || '').trim().toLowerCase();
    const addPartner = (name, source, extra) => {
      const key = normalize(name);
      if (!key) return;
      if (!partnerMap.has(key)) {
        partnerMap.set(key, { name: (name || '').trim(), country: '', loai_doi_tac: null, agreements: [], proposals: [], projectCount: 0 });
      }
      const p = partnerMap.get(key);
      if (source === 'thoa_thuan' && extra) {
        p.agreements.push(extra);
        if (extra.quoc_gia) p.country = extra.quoc_gia;
        if (extra.loai_doi_tac) p.loai_doi_tac = extra.loai_doi_tac;
      }
      if (source === 'mou' && extra) {
        p.proposals.push(extra);
        if (extra.quoc_gia) p.country = extra.quoc_gia;
      }
    };
    for (const r of thoaThuans || []) {
      addPartner(r.doi_tac, 'thoa_thuan', { loai: r.loai, trang_thai: r.trang_thai, het_han: r.het_han, ten: r.ten, quoc_gia: r.quoc_gia, loai_doi_tac: r.loai_doi_tac });
    }
    for (const r of mouDeXuats || []) {
      addPartner(r.ten_doi_tac, 'mou', { quoc_gia: r.quoc_gia, loai: r.loai_thoa_thuan, status: r.status });
    }
    for (const p of partnerMap.values()) {
      const name = (p.name || '').toLowerCase();
      for (const m of missions) {
        const cu = (m.cooperating_units || '').toLowerCase();
        if (cu && name && (cu.includes(name) || name.split(/\s+/).some(w => w.length > 3 && cu.includes(w)))) {
          p.projectCount++;
        }
      }
    }
    const partners = Array.from(partnerMap.values()).map(p => ({
      name: p.name,
      country: p.country,
      loai_doi_tac: p.loai_doi_tac,
      agreements: p.agreements,
      proposals: p.proposals,
      projectCount: p.projectCount,
      bestAgreementStatus: p.agreements.length ? (p.agreements.find(a => a.trang_thai === 'hieu_luc') ? 'hieu_luc' : p.agreements.find(a => a.trang_thai === 'sap_het_han') ? 'sap_het_han' : p.agreements[0].trang_thai) : null,
      bestAgreementLoai: p.agreements.length ? p.agreements[0].loai : null,
      hasProposal: p.proposals.length > 0
    })).sort((a, b) => (b.agreements.length + b.proposals.length + b.projectCount) - (a.agreements.length + a.proposals.length + a.projectCount));
    const inferLoai = (p) => {
      if (p.loai_doi_tac) return p.loai_doi_tac;
      const q = (p.country || '').toLowerCase();
      if (q.includes('việt nam') || q.includes('viet nam') || q.includes('vn')) return 'trong_nuoc';
      return 'quoc_te';
    };
    const stats = {
      quoc_te: partners.filter(p => inferLoai(p) === 'quoc_te').length,
      trong_nuoc: partners.filter(p => inferLoai(p) === 'trong_nuoc').length,
      doanh_nghiep: partners.filter(p => inferLoai(p) === 'doanh_nghiep').length,
      dia_phuong: partners.filter(p => inferLoai(p) === 'dia_phuong').length
    };
    const countries = new Set(partners.map(p => (p.country || '').trim()).filter(Boolean));
    return res.json({ partners, stats: { ...stats, so_quoc_gia: countries.size }, total: partners.length });
  } catch (e) {
    console.error('[API] cooperation/doi-tac error:', e.message);
    return res.json({ partners: [], stats: { quoc_te: 0, trong_nuoc: 0, doanh_nghiep: 0, dia_phuong: 0, so_quoc_gia: 0 }, total: 0 });
  }
});

// Danh sách Thỏa thuận (MOU, MOA, HĐ KH&CN, LOI)
app.get('/api/cooperation/thoa-thuan', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, created_at FROM cooperation_thoa_thuan ORDER BY trang_thai ASC, het_han ASC, id DESC'
    ).all();
    return res.json({ list: rows || [] });
  } catch (e) {
    return res.json({ list: [] });
  }
});

// Admin: thêm thỏa thuận đã có sẵn (nhập liệu)
app.post('/api/cooperation/thoa-thuan', authMiddleware, adminOnly, (req, res) => {
  const { ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac } = req.body || {};
  const tenTrim = (ten || '').trim();
  const doiTacTrim = (doi_tac || '').trim();
  const loaiTrim = (loai || '').trim();
  if (!tenTrim || !doiTacTrim || !loaiTrim) {
    return res.status(400).json({ message: 'Thiếu Tên thỏa thuận, Đối tác hoặc Loại' });
  }
  const loaiVal = loaiTrim;
  const allowedTrangThai = ['hieu_luc', 'sap_het_han', 'dang_tham_dinh', 'het_han'];
  const ttVal = (trang_thai || 'hieu_luc').trim().toLowerCase().replace(/\s+/g, '_');
  const trangThai = allowedTrangThai.includes(ttVal) ? ttVal : 'hieu_luc';
  const hetHanVal = (het_han || '').trim() || null;
  const quocGiaVal = (quoc_gia || '').trim() || null;
  const loaiValDt = ['quoc_te', 'trong_nuoc', 'doanh_nghiep', 'dia_phuong'].includes((loai_doi_tac || '').trim()) ? loai_doi_tac.trim() : null;
  try {
    db.prepare(
      'INSERT INTO cooperation_thoa_thuan (ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(tenTrim, doiTacTrim, loaiVal, hetHanVal, trangThai, quocGiaVal, loaiValDt);
    const row = db.prepare('SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, created_at FROM cooperation_thoa_thuan WHERE id = last_insert_rowid()').get();
    return res.status(201).json({ message: 'Đã thêm thỏa thuận.', item: row });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Admin: cập nhật vai trò; Admin có thể cấp Admin cho người khác; không được tự hạ vai trò của chính mình
app.put('/api/admin/users/role', authMiddleware, adminOnly, (req, res) => {
  const { email, role } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail && role !== 'admin') {
    return res.status(400).json({ message: 'Bạn không thể tự hạ vai trò của chính mình' });
  }
  const allowed = ['researcher', 'thanh_vien', 'thu_ky', 'chu_tich', 'admin', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
  if (!allowed.includes(role)) {
    return res.status(400).json({ message: 'Vai trò không hợp lệ' });
  }
  const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
  if (councilRoles.includes(role) && !em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'Chỉ tài khoản có đuôi @sci.edu.vn mới được gán vai trò Chủ tịch, Thư ký, Thành viên Hội đồng' });
  }
  const r = db.prepare('UPDATE users SET role = ? WHERE email = ?').run(role, em);
  if (r.changes === 0) {
    return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
  }
  return res.json({ message: 'Đã cập nhật vai trò' });
});

// Admin: danh sách Tổ thẩm định tài chính (Tổ trưởng, Thành viên)
app.get('/api/admin/budget-appraisal-team', authMiddleware, adminOnly, (req, res) => {
  const rows = db.prepare(
    "SELECT id, email, fullname, academicTitle, role, createdAt FROM users WHERE role IN ('totruong_tham_dinh_tc','thanh_vien_tham_dinh_tc') ORDER BY role, fullname, email"
  ).all();
  return res.json({ members: rows });
});

// Admin: cập nhật thành viên Tổ thẩm định tài chính (họ tên, học hàm học vị, vai trò)
app.put('/api/admin/budget-appraisal-team', authMiddleware, adminOnly, (req, res) => {
  const { email, fullname, academicTitle, role } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lòng nhập email' });
  const allowed = ['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
  const r = (role || '').toLowerCase();
  if (!allowed.includes(r)) return res.status(400).json({ message: 'Vai trò phải là Tổ trưởng hoặc Thành viên Tổ thẩm định TC' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (!existing) return res.status(404).json({ message: 'Không tìm thấy tài khoản. Thêm qua form bên trên trước.' });
  db.prepare('UPDATE users SET fullname = ?, academicTitle = ?, role = ? WHERE email = ?')
    .run((fullname || '').trim(), (academicTitle || '').trim() || null, r, em);
  return res.json({ message: 'Đã cập nhật thông tin thành viên Tổ thẩm định tài chính.' });
});

// Admin: xóa thành viên khỏi Tổ thẩm định tài chính (chuyển vai trò về Nghiên cứu viên)
app.delete('/api/admin/budget-appraisal-team/:email', authMiddleware, adminOnly, (req, res) => {
  const em = decodeURIComponent(req.params.email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email không hợp lệ' });
  const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
  if (!['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'].includes(row.role)) {
    return res.status(400).json({ message: 'Người này không phải thành viên Tổ thẩm định tài chính' });
  }
  db.prepare('UPDATE users SET role = ?, academicTitle = NULL WHERE email = ?').run('researcher', em);
  return res.json({ message: 'Đã xóa khỏi Tổ thẩm định tài chính. Tài khoản chuyển thành Nghiên cứu viên.' });
});

// Admin: cấp lại mật khẩu cho thành viên (đặt mật khẩu mới)
app.put('/api/admin/users/:email/password', authMiddleware, adminOnly, async (req, res) => {
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email không hợp lệ' });
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
  let newPassword = (req.body?.newPassword || '').trim();
  if (!newPassword || newPassword.length < 6) {
    newPassword = crypto.randomBytes(8).toString('hex');
  }
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, em);
  return res.json({ message: 'Đã cấp lại mật khẩu. Gửi mật khẩu tạm cho thành viên qua email nếu cần.', tempPassword: newPassword });
});

// Admin: xóa tài khoản thành viên (chỉ khi không có hồ sơ đã nộp)
app.delete('/api/admin/users/:email', authMiddleware, adminOnly, async (req, res) => {
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email không hợp lệ' });
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail) return res.status(400).json({ message: 'Bạn không thể xóa tài khoản của chính mình' });
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
  const hasSubs = db.prepare('SELECT 1 FROM submissions WHERE submittedById = ? LIMIT 1').get(row.id);
  const hasCapVien = dbCapVien.prepare('SELECT 1 FROM cap_vien_submissions WHERE submittedById = ? LIMIT 1').get(row.id);
  if (hasSubs || hasCapVien) {
    return res.status(400).json({ message: 'Không thể xóa: thành viên này đã có hồ sơ nộp trong hệ thống. Có thể chuyển vai trò về Nghiên cứu viên thay vì xóa.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
  return res.json({ message: 'Đã xóa tài khoản.' });
});

// Khởi tạo Admin mặc định (ntsinh0409@gmail.com) nếu chưa có; chuyển sinhnguyen@sci.edu.vn thành researcher
const adminExists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(ADMIN_EMAIL);
if (!adminExists) {
  bcrypt.hash('admin123', 10).then(hash => {
    db.prepare('INSERT INTO users (email, password, fullname, role) VALUES (?, ?, ?, ?)').run(ADMIN_EMAIL, hash, 'Admin', 'admin');
    console.log('Đã tạo tài khoản Admin mặc định: ' + ADMIN_EMAIL + ' / mật khẩu: admin123 (vui lòng đổi sau)');
  });
}
// Migration: đổi sinhnguyen@sci.edu.vn từ admin sang researcher
try {
  const r = db.prepare("UPDATE users SET role = 'researcher' WHERE email = 'sinhnguyen@sci.edu.vn' AND role = 'admin'").run();
  if (r.changes > 0) console.log('Đã chuyển sinhnguyen@sci.edu.vn thành Nghiên cứu viên.');
} catch (e) { /* ignore */ }

// Backfill gd5 history cho hồ sơ cũ đã có meeting result
try {
  const subsWithMeeting = db.prepare('SELECT id, meetingDecisionAt, meetingDecisionById, status FROM submissions WHERE meetingDecisionAt IS NOT NULL').all();
  subsWithMeeting.forEach(s => {
    const hasHistory = db.prepare('SELECT 1 FROM submission_gd5_history WHERE submissionId = ?').get(s.id);
    if (!hasHistory) {
      const label = s.status === 'CONDITIONAL' ? 'Chấp thuận có điều kiện' : (s.status === 'APPROVED' ? 'Chấp thuận' : 'Không chấp thuận');
      const mf = db.prepare("SELECT originalName FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").get(s.id);
      insertGd5History(s.id, 'meeting_result', s.meetingDecisionById, 'meeting_minutes', mf ? mf.originalName : null, label);
    }
  });
} catch (e) { /* ignore */ }

// CRD Lab Booking: nếu chưa có thư mục crd-lab-booking với index.html thì trả trang placeholder (tránh "Cannot GET")
const crdLabBookingPath = path.join(__dirname, 'crd-lab-booking', 'index.html');
app.get('/crd-lab-booking', (req, res) => res.redirect(302, '/crd-lab-booking/'));
app.get('/crd-lab-booking/', (req, res) => {
  if (fs.existsSync(crdLabBookingPath)) return res.sendFile(crdLabBookingPath);
  res.type('html').send(
    '<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>CRD Lab Booking</title></head><body style="font-family:Segoe UI;padding:40px;text-align:center;">' +
    '<h1>🏢 CRD Lab Booking</h1><p>Ứng dụng sẽ hiển thị tại đây khi bạn build dự án React ra thư mục <code>crd-lab-booking/</code>.</p>' +
    '<p><a href="/crd-lab-booking.html">Trang thông tin</a> · <a href="/index.html">Trang chủ</a></p></body></html>'
  );
});
app.get('/crd-lab-booking/index.html', (req, res) => {
  if (fs.existsSync(crdLabBookingPath)) return res.sendFile(crdLabBookingPath);
  res.redirect(302, '/crd-lab-booking.html');
});

// Phục vụ file tĩnh (HTML, CSS, v.v.) — sau tất cả route API
// Trả 404 JSON cho API không tồn tại (tránh HTML "Cannot POST/GET")
app.use('/api', (req, res) => {
  res.status(404).json({ message: 'Không tìm thấy API: ' + req.method + ' ' + req.path + '. Kiểm tra backend đang chạy: node server.js' });
});

app.use(express.static(__dirname));

// Email nhắc nhở duyệt đề xuất — mỗi 3 ngày, phong cách hành chính nhà nước
function sendApprovalReminderEmail() {
  if (!transporter) return;
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const moduleUrl = baseUrl + '/module-hoatac-quocte.html#de-xuat-cho-duyet';
  try {
    let choPhongKhcn = 0, choVienTruong = 0;
    const m = db.prepare('SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\'').get();
    let mouCount = (m && m.c) || 0;
    let doanVaoCount = 0;
    try {
      const dv = db.prepare('SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_tham_dinh\'').get();
      doanVaoCount = (dv && dv.c) || 0;
    } catch (e) {}
    choPhongKhcn = mouCount + doanVaoCount;
    const d = db.prepare('SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE lower(trim(status)) = \'cho_ky_duyet\'').get();
    const dCount = (d && d.c) || 0;
    let doanVaoVtCount = 0;
    try {
      const dv2 = db.prepare('SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_ky_duyet\'').get();
      doanVaoVtCount = (dv2 && dv2.c) || 0;
    } catch (e) {}
    let htqtCount = 0;
    try {
      const h = db.prepare('SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE lower(trim(status)) = \'cho_vt_phe_duyet\'').get();
      htqtCount = (h && h.c) || 0;
    } catch (e) {}
    choVienTruong = dCount + doanVaoVtCount + htqtCount;
    const total = choPhongKhcn + choVienTruong;
    if (total === 0) return;
    const rows = db.prepare('SELECT email, fullname, role FROM cooperation_notification_recipients').all();
    const vtEmails = [];
    const ccEmails = [];
    for (const r of rows || []) {
      const em = (r.email || '').trim().toLowerCase();
      if (!em) continue;
      if ((r.role || '').toString().toLowerCase() === 'vien_truong') vtEmails.push({ email: em, name: r.fullname });
      else ccEmails.push(em);
    }
    const phongKhcnUsers = db.prepare("SELECT email, fullname FROM users WHERE lower(trim(role)) = 'phong_khcn'").all();
    for (const u of phongKhcnUsers || []) {
      const em = (u.email || '').trim().toLowerCase();
      if (em && !vtEmails.some(x => x.email === em) && !ccEmails.includes(em)) ccEmails.push(em);
    }
    const toList = vtEmails.map(x => x.email);
    if (toList.length === 0 && ccEmails.length > 0) toList.push(ccEmails.shift());
    const allRecipients = [...new Set([...toList, ...ccEmails])];
    if (allRecipients.length === 0) return;
    const ngay = new Date().toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const subject = '[Hợp tác Quốc tế] Thông báo nhắc nhở xử lý đề xuất chờ duyệt';
    const bodyText = `Kính gửi Quý Ông/Bà,

Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc, Trường Đại học Khoa học Tự nhiên, ĐHQG-HCM xin trân trọng thông báo:

Hiện có ${total} đề xuất đang chờ xử lý phê duyệt (trong đó: ${choPhongKhcn} đề xuất chờ Phòng KHCN&QHĐN thẩm định; ${choVienTruong} đề xuất chờ Viện trưởng phê duyệt).

Đề nghị Quý Ông/Bà vui lòng đăng nhập vào hệ thống tại địa chỉ ${moduleUrl} để xem xét và xử lý kịp thời theo quy định.

Trân trọng,
Phòng KHCN&QHĐN — Viện Tế bào gốc`;
    const bodyHtml = `<p>Kính gửi Quý Ông/Bà,</p>
<p>Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc, Trường Đại học Khoa học Tự nhiên, ĐHQG-HCM xin trân trọng thông báo:</p>
<p>Hiện có <strong>${total}</strong> đề xuất đang chờ xử lý phê duyệt (trong đó: <strong>${choPhongKhcn}</strong> đề xuất chờ Phòng KHCN&QHĐN thẩm định; <strong>${choVienTruong}</strong> đề xuất chờ Viện trưởng phê duyệt).</p>
<p>Đề nghị Quý Ông/Bà vui lòng <a href="${moduleUrl}">đăng nhập vào hệ thống</a> để xem xét và xử lý kịp thời theo quy định.</p>
<p>Trân trọng,<br/>Phòng KHCN&QHĐN — Viện Tế bào gốc</p>`;
    transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: allRecipients.join(', '),
      subject,
      text: bodyText,
      html: bodyHtml
    }).then(() => console.log('[Email] Đã gửi nhắc nhở duyệt đề xuất tới', allRecipients.length, 'người nhận'))
      .catch(err => console.error('[Email] Lỗi gửi nhắc nhở:', err.message));
  } catch (e) {
    console.error('[Email] Lỗi chuẩn bị nhắc nhở:', e.message);
  }
}
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
setInterval(sendApprovalReminderEmail, THREE_DAYS_MS);
setTimeout(sendApprovalReminderEmail, 24 * 60 * 60 * 1000); // Gửi lần đầu sau 24h khi server khởi động

app.listen(PORT, () => {
  console.log('SCI-ACE server chạy tại http://localhost:' + PORT);
  console.log('Kiểm tra kết nối: http://localhost:' + PORT + '/api/health');
  if (transporter) console.log('SMTP đã cấu hình — email thông báo sẽ gửi khi có sự kiện (nộp hồ sơ, yêu cầu bổ sung, kết quả họp...)');
  else console.log('Chưa cấu hình SMTP — kiểm tra file .env (SMTP_HOST, SMTP_USER, SMTP_PASS). Email thông báo sẽ không gửi.');
  console.log('Email nhắc nhở duyệt đề xuất: mỗi 3 ngày (phong cách hành chính nhà nước)');
});
