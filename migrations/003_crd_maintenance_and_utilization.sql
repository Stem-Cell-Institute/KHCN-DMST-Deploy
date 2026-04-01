-- Phân tích sử dụng thiết bị / bảo trì — SQLite (sci-ace.db).
--
-- Ánh xạ với schema KHCN&ĐMST (CRD Lab Booking):
--   equipment      → crd_machines
--   equipment_id   → machine_id (TEXT)
--   bookings       → crd_bookings
--   Thời lượng sử dụng (giờ) = (end_h - start_h) trong cùng ngày `date`, không phải timestamp Unix.
--
-- Khởi động server cũng chạy các lệnh tương đương (idempotent) trong server.js.

-- Cột trên thiết bị (bỏ qua lỗi nếu đã có)
ALTER TABLE crd_machines ADD COLUMN accumulated_hours REAL DEFAULT 0;
ALTER TABLE crd_machines ADD COLUMN maintenance_threshold_hours REAL DEFAULT 500;
ALTER TABLE crd_machines ADD COLUMN last_maintenance_date TEXT;
ALTER TABLE crd_machines ADD COLUMN maintenance_notes TEXT;

CREATE TABLE IF NOT EXISTS crd_maintenance_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  maintenance_date TEXT NOT NULL,
  hours_at_maintenance REAL,
  type TEXT CHECK(type IS NULL OR type IN ('preventive','corrective','calibration')),
  performed_by TEXT,
  cost REAL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (machine_id) REFERENCES crd_machines(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crd_maint_log_machine ON crd_maintenance_log(machine_id);
CREATE INDEX IF NOT EXISTS idx_crd_maint_log_date ON crd_maintenance_log(maintenance_date);

-- Cộng dồn giờ khi lịch chuyển sang trạng thái hoàn thành (sau khi sử dụng thực tế).
-- Chỉ tính một lần khi chuyển từ trạng thái khác → 'completed'.
DROP TRIGGER IF EXISTS crd_trg_booking_accum_after_update;
CREATE TRIGGER crd_trg_booking_accum_after_update
AFTER UPDATE OF status ON crd_bookings
FOR EACH ROW
WHEN NEW.status = 'completed'
  AND IFNULL(OLD.status, '') != 'completed'
  AND NEW.end_h > NEW.start_h
BEGIN
  UPDATE crd_machines
  SET accumulated_hours = COALESCE(accumulated_hours, 0) + (NEW.end_h - NEW.start_h)
  WHERE id = NEW.machine_id;
END;

DROP TRIGGER IF EXISTS crd_trg_booking_accum_after_insert;
CREATE TRIGGER crd_trg_booking_accum_after_insert
AFTER INSERT ON crd_bookings
FOR EACH ROW
WHEN NEW.status = 'completed' AND NEW.end_h > NEW.start_h
BEGIN
  UPDATE crd_machines
  SET accumulated_hours = COALESCE(accumulated_hours, 0) + (NEW.end_h - NEW.start_h)
  WHERE id = NEW.machine_id;
END;
