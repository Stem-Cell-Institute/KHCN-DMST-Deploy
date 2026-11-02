-- Module Ngân hàng tế bào & Kháng thể: tủ/bình → ngăn → giá → hộp → mẫu (ống đông lạnh, kháng thể, sinh phẩm...).
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

-- Mẫu lưu trữ (ống đông lạnh, kháng thể, sinh phẩm...)
CREATE TABLE IF NOT EXISTS nhm_tubes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode TEXT,
  box_id INTEGER REFERENCES nhm_boxes(id),
  row_no INTEGER,
  col_no INTEGER,
  sample_type_id INTEGER REFERENCES nhm_sample_types(id),
  name TEXT NOT NULL,
  passage TEXT,
  cell_count REAL,
  volume_ml REAL,
  freeze_date TEXT,
  owner_user_id INTEGER,
  project TEXT,
  status TEXT NOT NULL DEFAULT 'in_storage'
    CHECK (status IN ('in_storage','checked_out','thawed','discarded')),
  extra_json TEXT,
  notes TEXT,
  deleted_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Một vị trí chỉ chứa một ống đang giữ chỗ (lưu kho hoặc đang lấy ra chờ trả lại)
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_tube_position ON nhm_tubes(box_id, row_no, col_no)
  WHERE status IN ('in_storage','checked_out') AND deleted_at IS NULL AND box_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_tube_barcode ON nhm_tubes(barcode)
  WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_nhm_tubes_box ON nhm_tubes(box_id);

-- Nhật ký chuỗi lưu giữ: chỉ thêm, không sửa/xóa
CREATE TABLE IF NOT EXISTS nhm_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tube_id INTEGER NOT NULL REFERENCES nhm_tubes(id),
  action TEXT NOT NULL,
  from_box_id INTEGER, from_row INTEGER, from_col INTEGER,
  to_box_id INTEGER, to_row INTEGER, to_col INTEGER,
  user_id INTEGER,
  note TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_nhm_movements_tube ON nhm_movements(tube_id);

-- Đổi tên loại cũ «Canister» thành «Hộp» (chỉ khi chưa có loại «Hộp»)
UPDATE nhm_container_types SET name = 'Hộp'
  WHERE name = 'Canister' AND NOT EXISTS (SELECT 1 FROM nhm_container_types WHERE name = 'Hộp');

-- Dữ liệu mặc định (quản lý có thể thêm/sửa sau)
INSERT OR IGNORE INTO nhm_container_types (name, default_temp_c, sort_order) VALUES
  ('Tủ -80°C', -80, 1),
  ('Tủ -20°C', -20, 2),
  ('Tủ lạnh 4°C', 4, 3),
  ('Bình nitơ lỏng', -196, 4),
  ('Ngăn', NULL, 5),
  ('Giá (rack)', NULL, 6),
  ('Ngăn kéo', NULL, 7),
  ('Hộp', NULL, 8);

INSERT OR IGNORE INTO nhm_box_templates (name, rows, cols) VALUES
  ('Hộp 9x9', 9, 9),
  ('Hộp 10x10', 10, 10),
  ('Hộp 5x5', 5, 5);

INSERT OR IGNORE INTO nhm_sample_types (name) VALUES
  ('Dòng tế bào'),
  ('Tế bào gốc'),
  ('Huyết thanh'),
  ('DNA/RNA'),
  ('Kháng thể'),
  ('Hóa chất / sinh phẩm'),
  ('Khác');
