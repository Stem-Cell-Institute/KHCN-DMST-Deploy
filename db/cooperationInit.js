/**
 * Khởi tạo bảng mở rộng và chuẩn hóa trạng thái cũ cho module Hợp tác Quốc tế.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../lib/db-bridge');

module.exports = function initCooperationTables() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS coop_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loai TEXT NOT NULL,
    de_xuat_id INTEGER NOT NULL,
    buoc INTEGER NOT NULL DEFAULT 1,
    action TEXT NOT NULL,
    action_label TEXT,
    performed_by_id INTEGER,
    performed_by_name TEXT,
    performed_by_role TEXT,
    note TEXT,
    performed_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_coop_history ON coop_history(loai, de_xuat_id)').run(); } catch(e) {}

  // --- Thêm cột mới vào các bảng hiện có (migration an toàn) ---
  ['cooperation_doan_ra','cooperation_doan_vao','cooperation_mou_de_xuat'].forEach(tbl => {
    [
      ['ma_de_xuat','TEXT'], ['submitted_by_id','INTEGER'],
      ['ghi_chu','TEXT'],    ['note_phong','TEXT'],
      ['note_vt','TEXT'],    ['phong_xu_ly_id','INTEGER'],
      ['phong_xu_ly_at','TEXT'], ['vt_xu_ly_id','INTEGER'],
      ['vt_xu_ly_at','TEXT'],
      ['van_ban_word_path','TEXT'],
      ['van_ban_word_original_name','TEXT'],
      ['van_ban_word_uploaded_at','TEXT'],
    ].forEach(([col, type]) => {
      try { db.prepare(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${type}`).run(); } catch(e) {}
    });
  });
  // Thêm cột cho htqt_de_xuat (đồng bộ quy trình với Đoàn ra / MOU: ghi chú, phê duyệt, Word)
  [['note_phong','TEXT'],['note_vt','TEXT'],['phong_xu_ly_id','INTEGER'],['phong_xu_ly_at','TEXT'],
   ['vt_xu_ly_id','INTEGER'],['vt_xu_ly_at','TEXT'],
   ['van_ban_word_path','TEXT'],['van_ban_word_original_name','TEXT'],['van_ban_word_uploaded_at','TEXT']].forEach(([col,type]) => {
    try { db.prepare(`ALTER TABLE htqt_de_xuat ADD COLUMN ${col} ${type}`).run(); } catch(e) {}
  });

  // --- Bảng Sự kiện Quốc tế (mới) ---
  db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_su_kien (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tieu_de TEXT NOT NULL,
    mo_ta TEXT,
    loai_su_kien TEXT DEFAULT 'hoi_thao',
    quoc_gia TEXT,
    dia_diem TEXT,
    ngay_bat_dau TEXT NOT NULL,
    ngay_ket_thuc TEXT,
    don_vi_to_chuc TEXT,
    link_su_kien TEXT,
    han_dang_ky TEXT,
    kinh_phi_tham_du TEXT,
    ghi_chu TEXT,
    tags TEXT,
    status TEXT DEFAULT 'sap_dien_ra',
    created_by_id INTEGER,
    created_by_name TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);

  // --- Migrate status cũ sang mới (an toàn, không phá dữ liệu) ---
  try { db.prepare("UPDATE cooperation_doan_vao SET status='cho_phong_duyet' WHERE status='cho_tham_dinh'").run(); } catch(e) {}
  try { db.prepare("UPDATE cooperation_doan_vao SET status='cho_vt_duyet' WHERE status='cho_ky_duyet'").run(); } catch(e) {}
  try { db.prepare("UPDATE cooperation_mou_de_xuat SET status='cho_phong_duyet' WHERE status='dang_tham_dinh'").run(); } catch(e) {}
  // Đoàn ra: trạng thái cũ cho_ky_duyet (nhầm với VT) → chờ Phòng KHCN thẩm định trước
  try { db.prepare("UPDATE cooperation_doan_ra SET status='cho_phong_duyet' WHERE lower(trim(status))='cho_ky_duyet'").run(); } catch(e) {}
  // YTNN: đồng bộ tên trạng thái với Đoàn ra / MOU (cho_phong_duyet → cho_vt_duyet → da_duyet / tu_choi)
  try { db.prepare("UPDATE htqt_de_xuat SET status='cho_phong_duyet' WHERE status='cho_phan_loai'").run(); } catch(e) {}
  try { db.prepare("UPDATE htqt_de_xuat SET status='cho_vt_duyet' WHERE status='cho_vt_phe_duyet'").run(); } catch(e) {}
  try { db.prepare("UPDATE htqt_de_xuat SET status='da_duyet' WHERE status='da_phe_duyet'").run(); } catch(e) {}
  try { db.prepare("UPDATE htqt_de_xuat SET status='tu_choi' WHERE status='khong_phe_duyet'").run(); } catch(e) {}

  // --- Tạo mã định danh cho đề xuất chưa có mã ---
  (function backfillMaDexuat() {
    const year = new Date().getFullYear();
    [
      { table: 'cooperation_doan_ra',    prefix: 'DR' },
      { table: 'cooperation_doan_vao',   prefix: 'DV' },
      { table: 'cooperation_mou_de_xuat',prefix: 'MU' },
      { table: 'htqt_de_xuat',           prefix: 'YT' },
    ].forEach(({ table, prefix }) => {
      try {
        const rows = db.prepare(`SELECT id FROM ${table} WHERE ma_de_xuat IS NULL OR ma_de_xuat = ''`).all();
        rows.forEach(r => {
          const ma = `ĐX-${year}-${prefix}${String(r.id).padStart(4,'0')}`;
          db.prepare(`UPDATE ${table} SET ma_de_xuat=? WHERE id=?`).run(ma, r.id);
        });
      } catch(e) {}
    });
  })();

  // Cột nhắc nội bộ (không hiển thị trên giao diện người nộp đề xuất)
  ['cooperation_doan_ra', 'cooperation_doan_vao', 'cooperation_mou_de_xuat', 'htqt_de_xuat'].forEach(tbl => {
    try { db.prepare(`ALTER TABLE ${tbl} ADD COLUMN coop_reminder_last_at TEXT`).run(); } catch (e) { /* đã có */ }
  });
};
