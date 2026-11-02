/**
 * Lược đồ DB của module Báo cáo phòng ban (tiền tố bảng: bcp_).
 *
 * Chỉ THÊM bảng mới bằng CREATE TABLE IF NOT EXISTS, không ALTER bảng của module khác — nên chạy
 * lại bao nhiêu lần cũng an toàn, và deploy lên production không động tới dữ liệu hiện có.
 *
 * `foreign_keys` được bật toàn cục (lib/db-bridge.js), nên khóa ngoại ở đây được thực thi
 * thật. Mọi tham chiếu tới `users` dùng SET NULL / CASCADE để không chặn việc xóa tài khoản
 * ở những nơi khác trong hệ thống.
 *
 * Mỗi câu lệnh gửi riêng một lệnh exec: chế độ Turso của db-bridge không chắc xử lý được
 * nhiều câu lệnh trong một chuỗi.
 *
 * Mô hình:
 *   bcp_phong ──< bcp_thanh_vien >── users
 *   bcp_mau ──< bcp_mau_phien_ban        (biểu mẫu; mỗi lần sửa = một phiên bản MỚI, bất biến)
 *   bcp_dot  ──> bcp_mau_phien_ban       (đợt ghim đúng phiên bản lúc tạo)
 *   bcp_dot ──< bcp_bao_cao >── bcp_phong (mỗi phòng một báo cáo trong mỗi đợt)
 *   bcp_bao_cao ──< bcp_lich_su
 *   bcp_dot ──< bcp_trinh_lan             (các lần quản lý module trình đợt cho Viện trưởng; Viện trưởng duyệt TRONG GIAO DIỆN)
 *   bcp_dot ──< bcp_dot_lich_su
 *   bcp_phong ──< bcp_loi_moi             (lời mời trưởng phòng cho email CHƯA có tài khoản)
 *   bcp_bao_cao ──< bcp_nhac_han          (nhật ký email nhắc trước hạn, để không nhắc trùng)
 *   bcp_bao_cao ──< bcp_y_kien            (ý kiến của Viện trưởng về từng báo cáo; không sửa/xóa, chỉ thêm)
 *
 * Vì sao phiên bản biểu mẫu bất biến: người quản lý sẽ sửa biểu mẫu theo nhu cầu về sau.
 * Nếu sửa tại chỗ thì các báo cáo ĐÃ NỘP theo mẫu cũ sẽ hiển thị sai (ô bị xóa mất, ô mới
 * trống). Ghim đợt vào một phiên bản cố định thì báo cáo cũ luôn hiển thị đúng như lúc nộp.
 */

const { chuanHoaMau } = require('./baoCaoPhongMau');
const { TEN_MAU_MAC_DINH, MO_TA_MAU_MAC_DINH, TRUONG_MAC_DINH } = require('./baoCaoPhongMauMacDinh');

// vai_tro: 'quan_ly'      — người quản lý module (phong_id để trống)
//          'vien_truong'  — Viện trưởng: có MỌI quyền của quan_ly, và là người nhận hồ sơ trình duyệt
//          'truong_phong' — gắn với một phòng
/**
 * Bảng báo cáo. `chu_id` = người phụ trách sở hữu báo cáo (đợt cách nộp "tat_ca": mỗi người một báo cáo riêng); NULL = báo cáo
 * chung của phòng. Mỗi (đợt, phòng, chủ) có đúng một dòng: ràng buộc nằm ở chỉ mục ux_bcp_bao_cao_chu (tạo trong ensureSchema), không
 * còn UNIQUE (dot_id, phong_id) như phiên bản đầu.
 */
function taoBaoCaoSql(ten) {
  return `CREATE TABLE ${ten} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dot_id INTEGER NOT NULL,
    phong_id INTEGER NOT NULL,
    chu_id INTEGER,
    trang_thai TEXT NOT NULL DEFAULT 'chua_nop'
      CHECK (trang_thai IN ('chua_nop','da_nop','can_chinh_sua','da_duyet')),
    du_lieu_json TEXT NOT NULL DEFAULT '{}',
    nguoi_nop_id INTEGER,
    nop_luc TEXT,
    nguoi_duyet_id INTEGER,
    duyet_luc TEXT,
    nhan_xet TEXT,
    cap_nhat_luc TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (dot_id) REFERENCES bcp_dot(id) ON DELETE CASCADE,
    FOREIGN KEY (phong_id) REFERENCES bcp_phong(id),
    FOREIGN KEY (chu_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (nguoi_nop_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (nguoi_duyet_id) REFERENCES users(id) ON DELETE SET NULL
  )`;
}

const TAO_THANH_VIEN = `CREATE TABLE IF NOT EXISTS bcp_thanh_vien (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    vai_tro TEXT NOT NULL CHECK (vai_tro IN ('quan_ly','vien_truong','truong_phong')),
    phong_id INTEGER,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (phong_id) REFERENCES bcp_phong(id),
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CHECK ((vai_tro IN ('quan_ly','vien_truong') AND phong_id IS NULL) OR (vai_tro = 'truong_phong' AND phong_id IS NOT NULL))
  )`;

const CAU_LENH = [
  `CREATE TABLE IF NOT EXISTS bcp_phong (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ma TEXT UNIQUE,
    ten TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`,

  TAO_THANH_VIEN,
  // Mỗi tài khoản giữ mỗi vai trò không gắn phòng một lần, và mỗi phòng một lần (truong_phong).
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_bcp_thanh_vien_vai_tro
     ON bcp_thanh_vien(user_id, vai_tro) WHERE vai_tro IN ('quan_ly','vien_truong')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_bcp_thanh_vien_phong
     ON bcp_thanh_vien(user_id, phong_id) WHERE vai_tro = 'truong_phong'`,

  `CREATE TABLE IF NOT EXISTS bcp_mau (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ten TEXT NOT NULL,
    mo_ta TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS bcp_mau_phien_ban (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mau_id INTEGER NOT NULL,
    so_phien_ban INTEGER NOT NULL,
    truong_json TEXT NOT NULL,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE (mau_id, so_phien_ban),
    FOREIGN KEY (mau_id) REFERENCES bcp_mau(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  )`,

  // loai: tuan | thang | quy | nam | dot_xuat.  trang_thai: nhap | dang_mo | dong
  // han_nop: ngày (AAAA-MM-DD, giờ Việt Nam). Hết ngày đó mà chưa nộp mới tính là trễ hạn.
  `CREATE TABLE IF NOT EXISTS bcp_dot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tieu_de TEXT NOT NULL,
    mo_ta TEXT,
    loai TEXT NOT NULL DEFAULT 'thang',
    ky TEXT,
    han_nop TEXT NOT NULL,
    mau_phien_ban_id INTEGER NOT NULL,
    trang_thai TEXT NOT NULL DEFAULT 'nhap' CHECK (trang_thai IN ('nhap','dang_mo','dong')),
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mau_phien_ban_id) REFERENCES bcp_mau_phien_ban(id),
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  )`,

  // trang_thai: chua_nop | da_nop | can_chinh_sua | da_duyet
  taoBaoCaoSql('IF NOT EXISTS bcp_bao_cao'),

  `CREATE TABLE IF NOT EXISTS bcp_lich_su (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bao_cao_id INTEGER NOT NULL,
    hanh_dong TEXT NOT NULL,
    nguoi_id INTEGER,
    ghi_chu TEXT,
    tao_luc TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (bao_cao_id) REFERENCES bcp_bao_cao(id) ON DELETE CASCADE,
    FOREIGN KEY (nguoi_id) REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_bcp_lich_su_bao_cao ON bcp_lich_su(bao_cao_id)`,

  `CREATE TABLE IF NOT EXISTS bcp_dot_lich_su (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dot_id INTEGER NOT NULL,
    hanh_dong TEXT NOT NULL,
    nguoi_id INTEGER,
    ghi_chu TEXT,
    tao_luc TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (dot_id) REFERENCES bcp_dot(id) ON DELETE CASCADE,
    FOREIGN KEY (nguoi_id) REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_bcp_dot_lich_su_dot ON bcp_dot_lich_su(dot_id)`,

  // Lời mời trưởng phòng cho một email CHƯA có tài khoản eoffice.
  //
  // Vì sao có mã (ma_bam) mà không tự gắn quyền cho 'bất kỳ ai đăng ký email đó': luồng đăng ký của hệ
  // thống KHÔNG xác minh quyền sở hữu email (ai gõ ten@sci.edu.vn cũng đăng ký và đăng nhập được ngay).
  // Nếu lời mời tự gắn vào tài khoản mới, kẻ đăng ký trước sẽ chiếm được quyền. Nên mã được gửi tới
  // CHÍNH hộp thư được mời: chỉ người đọc được hộp thư đó mới nhận được quyền, và vẫn phải đăng nhập
  // bằng đúng email đó. Mã chỉ lưu dạng BĂM (sha256): lộ DB cũng không lộ mã dùng được.
  // trang_thai: cho | da_nhan | huy. Chỉ cho vai trò truong_phong (quyền thấp nhất, một phòng).
  `CREATE TABLE IF NOT EXISTS bcp_loi_moi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    phong_id INTEGER NOT NULL,
    ma_bam TEXT NOT NULL UNIQUE,
    nguoi_moi_id INTEGER,
    tao_luc TEXT DEFAULT (datetime('now')),
    het_han TEXT NOT NULL,
    trang_thai TEXT NOT NULL DEFAULT 'cho' CHECK (trang_thai IN ('cho','da_nhan','huy')),
    nhan_luc TEXT,
    nguoi_nhan_id INTEGER,
    FOREIGN KEY (phong_id) REFERENCES bcp_phong(id),
    FOREIGN KEY (nguoi_moi_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (nguoi_nhan_id) REFERENCES users(id) ON DELETE SET NULL
  )`,
  // Mỗi (email, phòng) chỉ có một lời mời ĐANG CHỜ; lời mời đã nhận/hủy không cản mời lại.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_bcp_loi_moi_cho ON bcp_loi_moi(email, phong_id) WHERE trang_thai = 'cho'`,

  // Nhật ký nhắc hạn. loai: truoc_han (còn 1–2 ngày) | hom_nay (đúng ngày hạn). Khóa gồm CẢ han_nop: nếu người quản
  // lý dời hạn thì hạn mới được nhắc lại từ đầu. Dòng được "giành" (INSERT OR IGNORE) TRƯỚC khi gửi nên hai tiến
  // trình / hai lần chạy chồng nhau cũng chỉ nhắc một lần.
  `CREATE TABLE IF NOT EXISTS bcp_nhac_han (
    bao_cao_id INTEGER NOT NULL,
    loai TEXT NOT NULL CHECK (loai IN ('truoc_han','hom_nay')),
    han_nop TEXT NOT NULL,
    tao_luc TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (bao_cao_id, loai, han_nop),
    FOREIGN KEY (bao_cao_id) REFERENCES bcp_bao_cao(id) ON DELETE CASCADE
  )`,

  // Ý kiến của Viện trưởng về báo cáo của một phòng. Chỉ thêm (không sửa/xóa) để trưởng phòng luôn đọc đúng điều đã được thông báo qua email.
  `CREATE TABLE IF NOT EXISTS bcp_y_kien (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bao_cao_id INTEGER NOT NULL,
    nguoi_id INTEGER,
    noi_dung TEXT NOT NULL,
    tao_luc TEXT NOT NULL,
    FOREIGN KEY (bao_cao_id) REFERENCES bcp_bao_cao(id) ON DELETE CASCADE,
    FOREIGN KEY (nguoi_id) REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_bcp_y_kien_bao_cao ON bcp_y_kien(bao_cao_id)`,

  // Mỗi lần người quản lý module "trình" một đợt cho Viện trưởng là một dòng (trình lại = dòng mới, để nhắc). Không có tệp: toàn bộ
  // báo cáo của đợt hiện ra trong giao diện của Viện trưởng. Quyết định của Viện trưởng không có bảng riêng, nằm ở bcp_lich_su
  // (xem services/baoCaoPhongVienTruong.js).
  `CREATE TABLE IF NOT EXISTS bcp_trinh_lan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dot_id INTEGER NOT NULL,
    nguoi_trinh_id INTEGER,
    trinh_luc TEXT NOT NULL,
    loi_nhan TEXT,
    FOREIGN KEY (dot_id) REFERENCES bcp_dot(id) ON DELETE CASCADE,
    FOREIGN KEY (nguoi_trinh_id) REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_bcp_trinh_lan_dot ON bcp_trinh_lan(dot_id)`,
];

/**
 * Bảng bcp_thanh_vien của phiên bản đầu chưa có vai trò 'vien_truong' trong ràng buộc CHECK.
 * SQLite không sửa CHECK tại chỗ nên phải dựng lại bảng: đổi tên → tạo mới → chép dữ liệu → xóa cũ.
 * Chỉ chạy khi gặp bảng kiểu cũ (vd. DB dev đã tạo bảng từ trước); bảng mới tạo đã có sẵn đúng dạng.
 */
function canDoiThanhVien(db) {
  const r = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bcp_thanh_vien'").get();
  return !!r && !String(r.sql).includes("'vien_truong'");
}

function doiThanhVien(db) {
  db.transaction(() => {
    // Chỉ mục đi theo bảng khi đổi tên, nên phải bỏ trước kẻo trùng tên khi tạo lại.
    db.exec('DROP INDEX IF EXISTS ux_bcp_thanh_vien_quan_ly');
    db.exec('DROP INDEX IF EXISTS ux_bcp_thanh_vien_phong');
    db.exec('ALTER TABLE bcp_thanh_vien RENAME TO bcp_thanh_vien_cu');
    db.exec(TAO_THANH_VIEN);
    db.exec(
      `INSERT INTO bcp_thanh_vien (id, user_id, vai_tro, phong_id, created_by, created_at)
       SELECT id, user_id, vai_tro, phong_id, created_by, created_at FROM bcp_thanh_vien_cu`
    );
    db.exec('DROP TABLE bcp_thanh_vien_cu');
  })();
}

/**
 * Bảng bcp_bao_cao của phiên bản đầu có UNIQUE (dot_id, phong_id) (mỗi phòng đúng một báo cáo) và chưa có chu_id. Muốn mỗi người phụ trách
 * một báo cáo riêng phải bỏ ràng buộc đó; SQLite không bỏ được tại chỗ nên dựng lại bảng theo quy trình 12 bước của SQLite: tắt khóa ngoại
 * → tạo bảng mới → chép dữ liệu → xóa bảng cũ → đổi tên. Phải tắt khóa ngoại, nếu không xóa bảng cũ sẽ kéo theo xóa lịch sử, ý kiến, nhật ký nhắc
 * (ON DELETE CASCADE). Chạy trong một giao dịch: lỗi thì không đổi gì.
 */
function canDoiBaoCao(db) {
  const r = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bcp_bao_cao'").get();
  return !!r && !/\bchu_id\b/.test(String(r.sql));
}

function doiBaoCao(db) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec('DROP INDEX IF EXISTS ix_bcp_bao_cao_phong');
      db.exec(taoBaoCaoSql('bcp_bao_cao_moi'));
      db.exec(
        `INSERT INTO bcp_bao_cao_moi (id, dot_id, phong_id, trang_thai, du_lieu_json, nguoi_nop_id, nop_luc, nguoi_duyet_id, duyet_luc, nhan_xet, cap_nhat_luc)
         SELECT id, dot_id, phong_id, trang_thai, du_lieu_json, nguoi_nop_id, nop_luc, nguoi_duyet_id, duyet_luc, nhan_xet, cap_nhat_luc FROM bcp_bao_cao`
      );
      db.exec('DROP TABLE bcp_bao_cao');
      db.exec('ALTER TABLE bcp_bao_cao_moi RENAME TO bcp_bao_cao');
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** Nạp biểu mẫu mặc định ĐÚNG MỘT LẦN: chỉ khi chưa có biểu mẫu nào. */
function napMauMacDinh(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM bcp_mau').get().n > 0) return false;
  const kq = chuanHoaMau(TRUONG_MAC_DINH);
  // Mẫu mặc định hỏng là lỗi lập trình, không phải lỗi dữ liệu: phải ồn ào chứ không nuốt.
  if (!kq.ok) throw new Error('Biểu mẫu mặc định không hợp lệ: ' + kq.loi.join('; '));
  db.transaction(() => {
    const r = db.prepare('INSERT INTO bcp_mau (ten, mo_ta, created_by) VALUES (?, ?, NULL)').run(TEN_MAU_MAC_DINH, MO_TA_MAU_MAC_DINH);
    db.prepare('INSERT INTO bcp_mau_phien_ban (mau_id, so_phien_ban, truong_json, created_by) VALUES (?, 1, ?, NULL)').run(
      Number(r.lastInsertRowid),
      JSON.stringify(kq.truong)
    );
  })();
  return true;
}

/** Thêm cột nếu chưa có (SQLite không có "ADD COLUMN IF NOT EXISTS"). Dò qua sqlite_master như phần còn lại của file này. */
function themCot(db, bang, cot, kieu) {
  const r = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(bang);
  if (r && !new RegExp('\\b' + cot + '\\b').test(String(r.sql))) db.exec(`ALTER TABLE ${bang} ADD COLUMN ${cot} ${kieu}`);
}

function ensureSchema(db) {
  if (canDoiThanhVien(db)) doiThanhVien(db);
  // Bảng báo cáo kiểu cũ phải được chuyển TRƯỚC khi chạy CAU_LENH (CAU_LENH tạo chỉ mục trên cột chu_id mới).
  if (canDoiBaoCao(db)) doiBaoCao(db);
  for (const sql of CAU_LENH) db.exec(sql);
  db.exec('CREATE INDEX IF NOT EXISTS ix_bcp_bao_cao_phong ON bcp_bao_cao(phong_id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_bcp_bao_cao_chu ON bcp_bao_cao(dot_id, phong_id, COALESCE(chu_id, 0))');
  // Cách nộp của đợt: mot_nguoi (một báo cáo chung của phòng, ai nộp cũng được) | tat_ca (mỗi người phụ trách một báo cáo riêng).
  themCot(db, 'bcp_dot', 'cach_nop', "TEXT NOT NULL DEFAULT 'mot_nguoi'");
  // Chức danh của người phụ trách báo cáo phòng (xem services/baoCaoPhongChucDanh.js). Dòng cũ mặc định là Trưởng phòng.
  themCot(db, 'bcp_thanh_vien', 'chuc_danh', 'TEXT');
  themCot(db, 'bcp_loi_moi', 'chuc_danh', 'TEXT');
  db.exec("UPDATE bcp_thanh_vien SET chuc_danh = 'truong_phong' WHERE vai_tro = 'truong_phong' AND chuc_danh IS NULL");
  db.exec("UPDATE bcp_loi_moi SET chuc_danh = 'truong_phong' WHERE chuc_danh IS NULL");
  napMauMacDinh(db);
}

module.exports = { ensureSchema, CAU_LENH, napMauMacDinh };
