-- Module Ngân hàng Tế bào & Kháng thể: tủ/bình → ngăn → giá → hộp → mẫu (ống đông lạnh, kháng thể, sinh phẩm...).
-- Tiền tố bảng nhm_ giữ nguyên từ tên cũ «Ngân hàng mẫu» để không mất dữ liệu đã nhập.
-- Chạy idempotent qua db.exec trong server (CREATE IF NOT EXISTS + INSERT OR IGNORE).
-- Không khóa ngoại tới users: id người dùng chỉ lưu dạng số để module tách biệt.

-- Loại vật chứa do quản lý tự định nghĩa (tủ -80, tủ lạnh, bình nitơ, ngăn, giá...)
CREATE TABLE IF NOT EXISTS nhm_container_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  default_temp_c REAL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Cây vật chứa; parent_id NULL = tủ/bình gốc, độ sâu tùy ý
CREATE TABLE IF NOT EXISTS nhm_containers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES nhm_containers(id),
  type_id INTEGER NOT NULL REFERENCES nhm_container_types(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  temperature_c REAL,
  location_note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  -- Chỉ có nghĩa ở thiết bị GỐC (parent_id NULL); vị trí con thừa hưởng từ gốc.
  -- quan_ly_boi (tên cũ, giữ để không phải dựng lại bảng): 'cong_khai' = Public (ai cũng thêm mẫu vào ô trống);
  -- 'cellbank' = có ĐƠN VỊ QUẢN LÝ (don_vi_id): người dùng gửi yêu cầu, người duyệt của đơn vị quyết định. Hai cột luôn đi đôi.
  quan_ly_boi TEXT NOT NULL DEFAULT 'cong_khai' CHECK (quan_ly_boi IN ('cong_khai','cellbank')),
  don_vi_id INTEGER REFERENCES nhm_don_vi(id),
  -- Thiết bị RIÊNG: chỉ người này (và admin) thấy; chỉ có nghĩa ở thiết bị gốc. NULL = không riêng (Public hoặc có đơn vị quản lý).
  rieng_user_id INTEGER,
  -- Ngân hàng của thiết bị: 'te_bao' (ngân hàng tế bào) | 'khang_the' (ngân hàng kháng thể). Chỉ có nghĩa ở thiết bị GỐC; vị trí con theo gốc.
  ngan_hang TEXT NOT NULL DEFAULT 'te_bao' CHECK (ngan_hang IN ('te_bao','khang_the')),
  -- Vị trí SỐ của giá (rack) trong bình nitơ lỏng (1–50); NULL = không đánh số
  vi_tri INTEGER CHECK (vi_tri IS NULL OR vi_tri BETWEEN 1 AND 50),
  deleted_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_containers_code ON nhm_containers(code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_nhm_containers_parent ON nhm_containers(parent_id);

-- Mẫu hộp: 9x9, 10x10, 5x5...
CREATE TABLE IF NOT EXISTS nhm_box_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  rows INTEGER NOT NULL CHECK (rows BETWEEN 1 AND 26),
  cols INTEGER NOT NULL CHECK (cols BETWEEN 1 AND 30)
);

-- rows/cols được chụp lại từ mẫu để đổi mẫu không làm vỡ hộp cũ
CREATE TABLE IF NOT EXISTS nhm_boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id INTEGER NOT NULL REFERENCES nhm_containers(id),
  template_id INTEGER REFERENCES nhm_box_templates(id),
  rows INTEGER NOT NULL CHECK (rows BETWEEN 1 AND 26),
  cols INTEGER NOT NULL CHECK (cols BETWEEN 1 AND 30),
  code TEXT NOT NULL,
  name TEXT,
  notes TEXT,
  -- Vị trí SỐ của hộp trong giá (rack) của bình nitơ lỏng (1–50), số 1 ở trên cùng, càng lớn càng sâu; NULL = không đánh số
  vi_tri INTEGER CHECK (vi_tri IS NULL OR vi_tri BETWEEN 1 AND 50),
  deleted_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_boxes_code ON nhm_boxes(code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_nhm_boxes_container ON nhm_boxes(container_id);

CREATE TABLE IF NOT EXISTS nhm_sample_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

-- Vai trò TRONG module (không đụng users.role dùng chung toàn hệ thống). Chỉ admin cấp / gỡ.
--   quan_ly         quản lý module: thiết bị lưu trữ, hộp, danh mục, nhóm, hồ sơ thành viên, mọi mẫu (2–3 người)
--   truong_cellbank Trưởng CIPP (quản lý Cellbank): duyệt yêu cầu lấy mẫu ở thiết bị Cellbank
--   vien_truong     Viện trưởng: được tạo THIẾT BỊ RIÊNG (chỉ mình và admin thấy) và toàn quyền với thiết bị đó
CREATE TABLE IF NOT EXISTS nhm_vai_tro (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  vai_tro TEXT NOT NULL CHECK (vai_tro IN ('quan_ly','truong_cellbank','vien_truong')),
  -- Phạm vi ngân hàng của vai trò quan_ly: 'te_bao' | 'khang_the'; NULL = cả hai ngân hàng (các vai trò khác luôn NULL)
  ngan_hang TEXT CHECK (ngan_hang IS NULL OR ngan_hang IN ('te_bao','khang_the')),
  granted_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_vai_tro ON nhm_vai_tro (user_id, vai_tro, IFNULL(ngan_hang, ''));

-- Nhóm nghiên cứu. truong_user_id là TÀI KHOẢN (để gửi email duyệt yêu cầu), không phải tên gõ tay.
--   cho_xac_nhan  do người dùng tự đề xuất khi thêm mẫu, quản lý chưa kiểm
--   da_xac_nhan   quản lý đã kiểm (hoặc do quản lý tạo)
--   giai_the      nhóm đã giải thể (mẫu cũ giữ nguyên, không chọn được cho mẫu mới)
-- truong_xac_nhan = 1 khi chính người được ghi là trưởng nhóm bấm xác nhận (hoặc quản lý xác nhận thay).
CREATE TABLE IF NOT EXISTS nhm_nhom (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ten TEXT NOT NULL,
  ten_khoa TEXT NOT NULL,
  truong_user_id INTEGER,
  truong_xac_nhan INTEGER NOT NULL DEFAULT 0,
  trang_thai TEXT NOT NULL DEFAULT 'cho_xac_nhan' CHECK (trang_thai IN ('cho_xac_nhan','da_xac_nhan','giai_the')),
  ghi_chu TEXT,
  de_xuat_boi INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- ten_khoa = tên bỏ dấu, viết thường, gộp khoảng trắng: «Nhóm Nam» và «nhom  nam» là một nhóm
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_nhom_ten ON nhm_nhom(ten_khoa) WHERE trang_thai <> 'giai_the';

-- Hồ sơ thành viên do quản lý gán: loại (sinh viên / nghiên cứu viên / cán bộ) và nhóm. Người chưa có hồ sơ
-- vẫn dùng được module nhưng phải tự khai loại và nhóm khi thêm mẫu.
CREATE TABLE IF NOT EXISTS nhm_ho_so (
  user_id INTEGER PRIMARY KEY,
  loai TEXT NOT NULL CHECK (loai IN ('sinh_vien','nghien_cuu_vien','can_bo')),
  nhom_id INTEGER REFERENCES nhm_nhom(id),
  trang_thai TEXT NOT NULL DEFAULT 'dang_hoat_dong' CHECK (trang_thai IN ('dang_hoat_dong','da_roi_di')),
  -- Lời chào hiển thị ở đầu trang module thay cho tên (vd «Viện trưởng»); để trống thì chào bằng tên tài khoản
  chuc_danh TEXT,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mẫu lưu trữ (ống đông lạnh, kháng thể, sinh phẩm...)
CREATE TABLE IF NOT EXISTS nhm_tubes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id INTEGER REFERENCES nhm_boxes(id),
  row_no INTEGER,
  col_no INTEGER,
  sample_type_id INTEGER REFERENCES nhm_sample_types(id),
  name TEXT NOT NULL,
  passage TEXT,
  cell_count REAL,
  volume_ml REAL,
  -- Ống KHÁNG THỂ: thể tích ban đầu và còn lại, tính bằng microlit (µL). NULL = chưa ghi. Mọi thay đổi ghi vào sổ nhm_the_tich.
  the_tich_ul REAL,
  con_lai_ul REAL,
  -- Ống KHÁNG THỂ: 1 = chủ mẫu là đơn vị (AntibodyBank; mặc định; owner_user_id / chu_loai / nhom_id để trống), 0 = của cá nhân (vd mua bằng kinh phí cá nhân, xung công quỹ)
  chu_don_vi INTEGER NOT NULL DEFAULT 0,
  -- Ống tế bào thuộc một LÔ (stock) của một dòng tế bào (nhm_lo → nhm_dong_te_bao); NULL = chưa gắn dòng
  lo_id INTEGER REFERENCES nhm_lo(id),
  freeze_date TEXT,
  owner_user_id INTEGER,
  project TEXT,
  status TEXT NOT NULL DEFAULT 'in_storage'
    CHECK (status IN ('in_storage','checked_out','thawed','discarded')),
  -- Mẫu của sinh viên hay nghiên cứu viên / cán bộ (để lọc, và để biết ai duyệt yêu cầu khi sinh viên ra trường)
  chu_loai TEXT CHECK (chu_loai IS NULL OR chu_loai IN ('sinh_vien','nghien_cuu_vien','can_bo')),
  nhom_id INTEGER REFERENCES nhm_nhom(id),
  -- lần cuối kiểm kê hộp thấy mẫu còn ở ô này (UTC); NULL = chưa kiểm kê lần nào
  thay_luc TEXT,
  notes TEXT,
  deleted_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Một vị trí chỉ chứa một ống đang giữ chỗ (lưu kho hoặc đang lấy ra chờ trả lại)
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_tube_position ON nhm_tubes(box_id, row_no, col_no)
  WHERE status IN ('in_storage','checked_out') AND deleted_at IS NULL AND box_id IS NOT NULL;
-- Mã vạch không được dùng: bỏ chỉ mục của bản nháp cũ (cột barcode ở DB cũ, nếu có, để nguyên và không dùng nữa)
DROP INDEX IF EXISTS ux_nhm_tube_barcode;
CREATE INDEX IF NOT EXISTS ix_nhm_tubes_box ON nhm_tubes(box_id);
CREATE INDEX IF NOT EXISTS ix_nhm_tubes_nhom ON nhm_tubes(nhom_id);

-- Lịch sử MỌI thao tác trên mẫu: chỉ thêm, không sửa / xóa (có trigger chặn ở mức CSDL, bên dưới).
-- user_label = tên người thao tác TẠI THỜI ĐIỂM đó, để lịch sử vẫn đọc được khi tài khoản đổi tên hoặc bị xóa.
CREATE TABLE IF NOT EXISTS nhm_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tube_id INTEGER NOT NULL REFERENCES nhm_tubes(id),
  action TEXT NOT NULL,
  from_box_id INTEGER, from_row INTEGER, from_col INTEGER,
  to_box_id INTEGER, to_row INTEGER, to_col INTEGER,
  user_id INTEGER,
  user_label TEXT,
  note TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_nhm_movements_tube ON nhm_movements(tube_id);
CREATE TRIGGER IF NOT EXISTS trg_nhm_movements_khong_sua BEFORE UPDATE ON nhm_movements
BEGIN SELECT RAISE(ABORT, 'Lịch sử mẫu chỉ được thêm, không được sửa'); END;
CREATE TRIGGER IF NOT EXISTS trg_nhm_movements_khong_xoa BEFORE DELETE ON nhm_movements
BEGIN SELECT RAISE(ABORT, 'Lịch sử mẫu chỉ được thêm, không được xóa'); END;

-- Danh sách sinh viên của Viện do Trung tâm quản lý người học cung cấp (xem services/nganHangTeBaoKhangTheSinhVien.js).
-- Chỉ email có trong danh sách và còn hạn mới đăng ký được tài khoản vai trò sinh_vien (sau khi xác minh hộp thư).
--   het_han     hết NGÀY này (giờ Việt Nam) thì khóa quyền vào module Ngân hàng; tài khoản vẫn dùng được Đặt lịch thiết bị
--   trang_thai  'cho' còn hiệu lực | 'het_han' đã quét hết hạn | 'da_xoa' quản lý thu hồi
CREATE TABLE IF NOT EXISTS nhm_sinh_vien (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  fullname TEXT NOT NULL,
  ma_sv TEXT,
  khoa TEXT,
  het_han TEXT NOT NULL,
  trang_thai TEXT NOT NULL DEFAULT 'cho' CHECK (trang_thai IN ('cho','het_han','da_xoa')),
  ghi_chu TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_nhm_sinh_vien_han ON nhm_sinh_vien(het_han);

-- Cấu hình do quản lý chỉnh (hiện: các hạn chờ). Không có dòng thì dùng giá trị mặc định trong
-- services/nganHangTeBaoKhangTheYeuCau.js (HAN_MAC_DINH).
CREATE TABLE IF NOT EXISTS nhm_cau_hinh (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══ Đợt 2: yêu cầu lấy mẫu, mẫu chưa khai báo, mẫu nghi mất ═══════════════════════════════════════════════

-- Yêu cầu lấy mẫu của người khác. cap = ai đang là người duyệt:
--   chu_mau         chủ mẫu (cán bộ / nghiên cứu viên còn hoạt động) — thiết bị công khai
--   truong_nhom     trưởng nhóm (mẫu sinh viên, hoặc chủ mẫu đã rời đi) — thiết bị công khai
--   truong_cellbank Trưởng CIPP — thiết bị Cellbank
--   quan_ly         quản lý module (khi cấp trên không có hoặc quá hạn phản hồi)
-- Quản lý và admin luôn xử lý được (xu_ly_thay = 1 khi không phải người duyệt của cấp hiện tại, kèm ly_do_xu_ly).
CREATE TABLE IF NOT EXISTS nhm_yeu_cau (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tube_id INTEGER NOT NULL REFERENCES nhm_tubes(id),
  nguoi_gui_id INTEGER NOT NULL,
  ly_do TEXT,
  cap TEXT NOT NULL CHECK (cap IN ('chu_mau','truong_nhom','truong_cellbank','quan_ly')),
  han_phan_hoi TEXT NOT NULL,
  trang_thai TEXT NOT NULL DEFAULT 'cho_duyet'
    CHECK (trang_thai IN ('cho_duyet','da_duyet','tu_choi','da_giao','da_tra','da_huy')),
  leo_thang_luc TEXT,
  xu_ly_boi INTEGER,
  xu_ly_luc TEXT,
  xu_ly_thay INTEGER NOT NULL DEFAULT 0,
  ly_do_xu_ly TEXT,
  -- ngân hàng kháng thể: số µL người xin cần và số µL quản lý đã giao (NULL ở ngân hàng tế bào)
  so_ul_yeu_cau REAL,
  so_ul_giao REAL,
  -- ngân hàng kháng thể: yêu cầu được duyệt theo ỦY QUYỀN nào của Viện trưởng (nhm_uy_quyen_duyet); NULL = Viện trưởng tự duyệt
  uy_quyen_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Mỗi mẫu chỉ có MỘT yêu cầu đang xử lý tại một thời điểm
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_yeu_cau_mo ON nhm_yeu_cau(tube_id) WHERE trang_thai IN ('cho_duyet','da_duyet','da_giao');
CREATE INDEX IF NOT EXISTS ix_nhm_yeu_cau_gui ON nhm_yeu_cau(nguoi_gui_id);

-- Mẫu có thật trong ô nhưng chưa khai báo (thiết bị công khai). Ô bị giữ chỗ cho tới khi chủ mẫu nhận hoặc quản lý bỏ mẫu.
CREATE TABLE IF NOT EXISTS nhm_phat_hien (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id INTEGER NOT NULL REFERENCES nhm_boxes(id),
  row_no INTEGER NOT NULL,
  col_no INTEGER NOT NULL,
  mo_ta TEXT NOT NULL,
  nghi_user_id INTEGER,
  nghi_nhom_id INTEGER REFERENCES nhm_nhom(id),
  trang_thai TEXT NOT NULL DEFAULT 'cho_chu_mau' CHECK (trang_thai IN ('cho_chu_mau','da_khai_bao','da_bo','da_huy')),
  nguoi_phat_hien_id INTEGER NOT NULL,
  nhac_lan INTEGER NOT NULL DEFAULT 0,
  nhac_dau_luc TEXT,
  nhac_cuoi_luc TEXT,
  tube_id INTEGER REFERENCES nhm_tubes(id),
  xu_ly_boi INTEGER,
  xu_ly_luc TEXT,
  bo_som INTEGER NOT NULL DEFAULT 0,
  ly_do_xu_ly TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_phat_hien_o ON nhm_phat_hien(box_id, row_no, col_no) WHERE trang_thai = 'cho_chu_mau';

-- Lịch sử riêng của từng lần phát hiện (không gắn với bản ghi mẫu vì mẫu chưa có bản ghi): chỉ thêm, không sửa / xóa
CREATE TABLE IF NOT EXISTS nhm_phat_hien_ls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phat_hien_id INTEGER NOT NULL REFERENCES nhm_phat_hien(id),
  action TEXT NOT NULL,
  user_id INTEGER,
  user_label TEXT,
  note TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_nhm_phat_hien_ls ON nhm_phat_hien_ls(phat_hien_id);
CREATE TRIGGER IF NOT EXISTS trg_nhm_phat_hien_ls_khong_sua BEFORE UPDATE ON nhm_phat_hien_ls
BEGIN SELECT RAISE(ABORT, 'Lịch sử phát hiện chỉ được thêm, không được sửa'); END;
CREATE TRIGGER IF NOT EXISTS trg_nhm_phat_hien_ls_khong_xoa BEFORE DELETE ON nhm_phat_hien_ls
BEGIN SELECT RAISE(ABORT, 'Lịch sử phát hiện chỉ được thêm, không được xóa'); END;

-- Mẫu nghi mất / bị lấy không qua yêu cầu. Mẫu vẫn giữ ô trong hộp trong lúc vụ việc còn mở.
--   mo                đang tìm, ai cũng thấy; người đã lấy có thể tự nhận
--   cho_chu_xac_nhan  có người nhận đã lấy, chờ chủ mẫu xác nhận
--   da_xac_nhan_lay   chủ mẫu xác nhận có người lấy không xin phép (tính vào số lần vi phạm của người lấy)
--   da_tim_thay       tìm thấy mẫu
--   that_lac          hết hạn không ai nhận, quản lý chốt thất lạc
--   da_huy            báo nhầm
CREATE TABLE IF NOT EXISTS nhm_vu_viec (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tube_id INTEGER NOT NULL REFERENCES nhm_tubes(id),
  nguon TEXT NOT NULL CHECK (nguon IN ('chu_mau','kiem_ke','quan_ly')),
  nguoi_bao_id INTEGER NOT NULL,
  mo_ta TEXT,
  trang_thai TEXT NOT NULL DEFAULT 'mo'
    CHECK (trang_thai IN ('mo','cho_chu_xac_nhan','da_xac_nhan_lay','da_tim_thay','that_lac','da_huy')),
  nguoi_nhan_id INTEGER,
  nhan_luc TEXT,
  nhan_ghi_chu TEXT,
  han_nhan TEXT NOT NULL,
  xu_ly_boi INTEGER,
  xu_ly_luc TEXT,
  ly_do_xu_ly TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_vu_viec_mo ON nhm_vu_viec(tube_id) WHERE trang_thai IN ('mo','cho_chu_xac_nhan');

-- Đổi tên loại cũ «Canister» thành «Hộp» (chỉ khi chưa có loại «Hộp»)
UPDATE nhm_container_types SET name = 'Hộp'
  WHERE name = 'Canister' AND NOT EXISTS (SELECT 1 FROM nhm_container_types WHERE name = 'Hộp');

-- Dữ liệu mặc định: chỉ nạp MỘT LẦN (đánh dấu trong nhm_meta). Quản lý thêm / sửa / xóa danh mục sau đó
-- (xem routes/nganHangTeBaoKhangThe/danhMuc.js); xóa một mục mặc định thì lần khởi động sau không nạp lại.
CREATE TABLE IF NOT EXISTS nhm_meta (key TEXT PRIMARY KEY, value TEXT);

INSERT OR IGNORE INTO nhm_container_types (name, default_temp_c, sort_order)
  SELECT column1, column2, column3 FROM (VALUES
    ('Tủ -80°C', -80, 1),
    ('Tủ -20°C', -20, 2),
    ('Tủ lạnh 4°C', 4, 3),
    ('Bình nitơ lỏng', -196, 4),
    ('Ngăn', NULL, 5),
    ('Rack', NULL, 6),
    ('Ngăn kéo', NULL, 7),
    ('Hộp', NULL, 8))
  WHERE NOT EXISTS (SELECT 1 FROM nhm_meta WHERE key = 'seed_v1');

INSERT OR IGNORE INTO nhm_box_templates (name, rows, cols)
  SELECT column1, column2, column3 FROM (VALUES
    ('Hộp 9x9', 9, 9),
    ('Hộp 10x10', 10, 10),
    ('Hộp 5x5', 5, 5))
  WHERE NOT EXISTS (SELECT 1 FROM nhm_meta WHERE key = 'seed_v1');

INSERT OR IGNORE INTO nhm_sample_types (name)
  SELECT column1 FROM (VALUES
    ('Dòng tế bào'),
    ('Tế bào gốc'),
    ('Huyết thanh'),
    ('DNA/RNA'),
    ('Kháng thể'),
    ('Hóa chất / sinh phẩm'),
    ('Khác'))
  WHERE NOT EXISTS (SELECT 1 FROM nhm_meta WHERE key = 'seed_v1');

INSERT OR IGNORE INTO nhm_meta (key, value) VALUES ('seed_v1', datetime('now'));

-- Đổi tên loại có sẵn «Giá (rack)» thành «Rack» cho dữ liệu đã tạo từ bản trước (chỉ khi chưa có loại tên Rack; id giữ nguyên nên không mất liên kết)
UPDATE nhm_container_types SET name = 'Rack'
  WHERE name = 'Giá (rack)' AND NOT EXISTS (SELECT 1 FROM nhm_container_types WHERE name = 'Rack');

-- Đơn vị quản lý thiết bị: thiết bị gắn với đơn vị thì mọi yêu cầu lấy mẫu phải được người duyệt của đơn vị đồng ý.
-- Thiết bị không gắn đơn vị là Public. Người duyệt = các tài khoản trong nhm_don_vi_duyet, cộng (nếu có) những người giữ
-- vai trò vai_tro_duyet (đơn vị Cellbank: Trưởng CIPP). Chỉ admin tạo / sửa đơn vị và người duyệt.
CREATE TABLE IF NOT EXISTS nhm_don_vi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ma TEXT NOT NULL UNIQUE,
  ten TEXT NOT NULL,
  mo_ta TEXT,
  vai_tro_duyet TEXT CHECK (vai_tro_duyet IS NULL OR vai_tro_duyet IN ('truong_cellbank')),
  ngan_hang TEXT NOT NULL DEFAULT 'te_bao' CHECK (ngan_hang IN ('te_bao','khang_the')),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_don_vi_ten ON nhm_don_vi(LOWER(ten));

CREATE TABLE IF NOT EXISTS nhm_don_vi_duyet (
  don_vi_id INTEGER NOT NULL REFERENCES nhm_don_vi(id),
  user_id INTEGER NOT NULL,
  granted_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (don_vi_id, user_id)
);

INSERT OR IGNORE INTO nhm_don_vi (ma, ten, mo_ta, vai_tro_duyet)
  VALUES ('cellbank', 'Cellbank', 'Thiết bị do Cellbank (CIPP) quản lý; Trưởng CIPP duyệt yêu cầu lấy mẫu.', 'truong_cellbank');
-- AntibodyBank: đơn vị quản lý DUY NHẤT của ngân hàng kháng thể (không có Public). Người duyệt luôn là Viện trưởng (vai trò vien_truong);
-- người quản lý ngân hàng kháng thể chỉ theo dõi và giao / nhận lại mẫu. Tên cũ «Ab-bank» được đổi tên tại chỗ (giữ id, thiết bị, yêu cầu).
UPDATE nhm_don_vi SET ma = 'antibodybank', ten = 'AntibodyBank', mo_ta = 'Đơn vị quản lý toàn bộ thiết bị của ngân hàng kháng thể; Viện trưởng duyệt yêu cầu lấy mẫu, quản lý ngân hàng kháng thể giao và nhận lại mẫu.'
  WHERE ma = 'ab-bank' AND NOT EXISTS (SELECT 1 FROM nhm_don_vi WHERE ma = 'antibodybank');
INSERT OR IGNORE INTO nhm_don_vi (ma, ten, mo_ta, ngan_hang)
  VALUES ('antibodybank', 'AntibodyBank', 'Đơn vị quản lý toàn bộ thiết bị của ngân hàng kháng thể; Viện trưởng duyệt yêu cầu lấy mẫu, quản lý ngân hàng kháng thể giao và nhận lại mẫu.', 'khang_the');
-- Ngân hàng kháng thể không có Public / thiết bị riêng: mọi thiết bị gốc thuộc AntibodyBank
UPDATE nhm_containers SET don_vi_id = (SELECT id FROM nhm_don_vi WHERE ma = 'antibodybank'), quan_ly_boi = 'cellbank', rieng_user_id = NULL
  WHERE ngan_hang = 'khang_the' AND parent_id IS NULL AND (don_vi_id IS NULL OR rieng_user_id IS NOT NULL);
-- thiết bị Cellbank tạo từ bản trước chưa có đơn vị: gắn vào đơn vị Cellbank
UPDATE nhm_containers SET don_vi_id = (SELECT id FROM nhm_don_vi WHERE ma = 'cellbank')
  WHERE quan_ly_boi = 'cellbank' AND don_vi_id IS NULL AND parent_id IS NULL;
CREATE INDEX IF NOT EXISTS ix_nhm_containers_don_vi ON nhm_containers(don_vi_id);

-- ═══ Sổ thể tích của ống kháng thể (µL): chỉ thêm, không sửa / xóa ═══════════════════════════════════════════
--   hanh_dong  ban_dau    ghi thể tích ban đầu (so_ul = +V)
--              dung       một lần dùng (so_ul âm); nguoi_dung = người dùng kháng thể; yeu_cau_id nếu đi qua yêu cầu
--              dieu_chinh đo lại / sửa số còn lại (so_ul = chênh lệch, ghi_chu = lý do)
--              het        ống hết và được bỏ khỏi kho (so_ul = phần còn lại bị xóa sổ, 0 nếu đã dùng hết; con_lai_ul = 0)
-- Mỗi dòng cũng có một dòng tương ứng trong lịch sử mẫu (nhm_movements) để đọc theo trình tự thời gian.
CREATE TABLE IF NOT EXISTS nhm_the_tich (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tube_id INTEGER NOT NULL REFERENCES nhm_tubes(id),
  hanh_dong TEXT NOT NULL CHECK (hanh_dong IN ('ban_dau','dung','dieu_chinh','het')),
  so_ul REAL NOT NULL,
  con_lai_ul REAL NOT NULL,
  nguoi_dung_id INTEGER,
  nguoi_dung_label TEXT,
  yeu_cau_id INTEGER,
  ghi_chu TEXT,
  user_id INTEGER,
  user_label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_nhm_the_tich_tube ON nhm_the_tich(tube_id);
CREATE TRIGGER IF NOT EXISTS trg_nhm_the_tich_khong_sua BEFORE UPDATE ON nhm_the_tich
BEGIN SELECT RAISE(ABORT, 'Sổ thể tích chỉ được thêm, không được sửa'); END;
CREATE TRIGGER IF NOT EXISTS trg_nhm_the_tich_khong_xoa BEFORE DELETE ON nhm_the_tich
BEGIN SELECT RAISE(ABORT, 'Sổ thể tích chỉ được thêm, không được xóa'); END;

-- ═══ Ủy quyền duyệt (ngân hàng kháng thể) ═══════════════════════════════════════════════════════════════════════
-- Viện trưởng giao quyền DUYỆT yêu cầu lấy một phần kháng thể cho một quản lý ngân hàng kháng thể. Viện trưởng vẫn duyệt được mọi yêu cầu.
--   pham_vi  ngan_hang (mọi kháng thể) | vi_tri (một thiết bị / Rack và mọi hộp bên trong, vi_tri_id) | hop (hop_id) | ten_mau (một loại kháng thể theo tên)
--   den_ngay hết NGÀY này (giờ Việt Nam) thì ủy quyền tự hết hiệu lực; NULL = không hạn, tới khi thu hồi
-- Thu hồi chỉ ghi thu_hoi_luc (không xóa) để lịch sử duyệt vẫn truy được ai duyệt theo ủy quyền nào.
CREATE TABLE IF NOT EXISTS nhm_uy_quyen_duyet (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nguoi_id INTEGER NOT NULL,
  pham_vi TEXT NOT NULL CHECK (pham_vi IN ('ngan_hang','vi_tri','hop','ten_mau')),
  vi_tri_id INTEGER,
  hop_id INTEGER,
  ten_mau TEXT,
  den_ngay TEXT,
  ghi_chu TEXT,
  tao_boi INTEGER NOT NULL,
  tao_luc TEXT NOT NULL DEFAULT (datetime('now')),
  thu_hoi_luc TEXT,
  thu_hoi_boi INTEGER
);
CREATE INDEX IF NOT EXISTS ix_nhm_uy_quyen_nguoi ON nhm_uy_quyen_duyet(nguoi_id);

-- ═══ Hồ sơ dòng tế bào, lô (stock), kiểm soát chất lượng (QC), tệp đính kèm — ngân hàng TẾ BÀO ═══════════════════════════
-- Dòng tế bào = thông tin sinh học dùng chung cho mọi ống của dòng đó; một dòng có nhiều LÔ đông lạnh (stock, mỗi lô có passage, ngày đông,
-- tỉ lệ sống sót); mỗi ống (nhm_tubes.lo_id) thuộc một lô. QC (mycoplasma, STR, sống sót...) ghi theo dòng hoặc lô, chỉ thêm, không sửa / xóa.
-- bien_doi_gen = 1: dòng biến đổi gen (GMO); bsl = cấp an toàn sinh học 1–4 → báo cáo GMO / an toàn sinh học.
CREATE TABLE IF NOT EXISTS nhm_dong_te_bao (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ma TEXT NOT NULL,
  ten TEXT NOT NULL,
  loai_sinh_vat TEXT,
  mo_nguon_goc TEXT,
  benh TEXT,
  loai_dong TEXT CHECK (loai_dong IS NULL OR loai_dong IN ('dong_ban_dau','dong_vo_han','ipsc','khac')),
  dang_nuoi TEXT CHECK (dang_nuoi IS NULL OR dang_nuoi IN ('bam_dinh','huyen_phu','khac')),
  moi_truong TEXT,
  bo_sung TEXT,
  nhiet_do_c REAL,
  co2_phan_tram REAL,
  thoi_gian_nhan_doi TEXT,
  hinh_thai TEXT,
  dac_diem_tang_truong TEXT,
  nguon_cung_cap TEXT,
  ma_nguon TEXT,
  bien_doi_gen INTEGER NOT NULL DEFAULT 0 CHECK (bien_doi_gen IN (0,1)),
  gmo_mo_ta TEXT,
  bsl INTEGER CHECK (bsl IS NULL OR bsl BETWEEN 1 AND 4),
  du_an TEXT,
  nhom_id INTEGER,
  ghi_chu TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_dong_ma ON nhm_dong_te_bao(LOWER(ma)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS nhm_lo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dong_id INTEGER NOT NULL REFERENCES nhm_dong_te_bao(id),
  ma TEXT NOT NULL,
  passage TEXT,
  ngay_dong_lanh TEXT,
  so_te_bao_moi_ong REAL,
  ty_le_song_sot REAL CHECK (ty_le_song_sot IS NULL OR ty_le_song_sot BETWEEN 0 AND 100),
  moi_truong_dong TEXT,
  ghi_chu TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_lo_ma ON nhm_lo(dong_id, LOWER(ma)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS nhm_qc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dong_id INTEGER NOT NULL REFERENCES nhm_dong_te_bao(id),
  lo_id INTEGER REFERENCES nhm_lo(id),
  loai TEXT NOT NULL CHECK (loai IN ('mycoplasma','str','song_sot','vi_khuan_nam','hinh_thai','khac')),
  ket_qua TEXT NOT NULL CHECK (ket_qua IN ('dat','khong_dat','am_tinh','duong_tinh','khac')),
  ngay TEXT NOT NULL,
  phuong_phap TEXT,
  ghi_chu TEXT,
  user_id INTEGER,
  user_label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_nhm_qc_dong ON nhm_qc(dong_id);
CREATE TRIGGER IF NOT EXISTS trg_nhm_qc_khong_sua BEFORE UPDATE ON nhm_qc BEGIN SELECT RAISE(ABORT, 'Kết quả QC chỉ được thêm, không được sửa'); END;
CREATE TRIGGER IF NOT EXISTS trg_nhm_qc_khong_xoa BEFORE DELETE ON nhm_qc BEGIN SELECT RAISE(ABORT, 'Kết quả QC chỉ được thêm, không được xóa'); END;

-- Tệp đính kèm (PDF, ảnh, bảng tính...) của dòng / lô / kết quả QC. Nội dung nằm trên đĩa (thư mục uploads/ngan-hang), tên lưu là chuỗi ngẫu nhiên;
-- xóa chỉ đánh dấu xoa_luc (giữ tệp và dòng này để truy vết). sha256 để biết tệp có bị thay đổi.
CREATE TABLE IF NOT EXISTS nhm_tep (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doi_tuong TEXT NOT NULL CHECK (doi_tuong IN ('dong','lo','qc')),
  doi_tuong_id INTEGER NOT NULL,
  ten_goc TEXT NOT NULL,
  mime TEXT NOT NULL,
  kich_thuoc INTEGER NOT NULL,
  khoa TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  mo_ta TEXT,
  tao_boi INTEGER,
  tao_boi_ten TEXT,
  tao_luc TEXT NOT NULL DEFAULT (datetime('now')),
  xoa_luc TEXT,
  xoa_boi INTEGER
);
CREATE INDEX IF NOT EXISTS ix_nhm_tep_dt ON nhm_tep(doi_tuong, doi_tuong_id);
