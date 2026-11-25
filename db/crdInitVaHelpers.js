/**
 * Khởi tạo schema CRD, migration, seed máy/vai trò và helper chuyển đổi dữ liệu CRD.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../lib/db-bridge');

module.exports = function createCrdInitAndHelpers() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS crd_machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT,
    location TEXT,
    color TEXT DEFAULT '#667eea',
    avail_from INTEGER DEFAULT 8,
    avail_to INTEGER DEFAULT 20,
    max_hours INTEGER DEFAULT 4,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS crd_persons (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'user',
    avatar TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS crd_bookings (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    date TEXT NOT NULL,
    start_h REAL NOT NULL,
    end_h REAL NOT NULL,
    purpose TEXT,
    status TEXT DEFAULT 'confirmed',
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS crd_chats (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    booking_id TEXT,
    msg TEXT NOT NULL,
    ts INTEGER NOT NULL,
    read_flag INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS crd_complaints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id TEXT NOT NULL,
    against_id TEXT,
    booking_id TEXT,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    admin_note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

  db.exec(`
  CREATE TABLE IF NOT EXISTS crd_role_defs (
    slug TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_admin_slot INTEGER DEFAULT 0
  );
`);
  try {
    const insRd = db.prepare(
      'INSERT OR IGNORE INTO crd_role_defs (slug, label, sort_order, is_admin_slot) VALUES (?,?,?,?)'
    );
    insRd.run('user', 'Researcher', 0, 0);
    insRd.run('admin', 'Admin CRD', 1, 1);
  } catch (e) {
    /* ignore */
  }

  function crdMachineToClient(r) {
    if (!r) return null;
    const af = r.avail_from != null ? Number(r.avail_from) : null;
    const at = r.avail_to != null ? Number(r.avail_to) : null;
    return {
      id: r.id,
      name: r.name,
      type: r.type || '',
      location: r.location || '',
      color: r.color || '#667eea',
      availFrom: Number.isFinite(af) ? af : null,
      availTo: Number.isFinite(at) ? at : null,
      maxHours: r.max_hours != null ? Number(r.max_hours) : null,
      desc: r.description || '',
      sort_order: r.sort_order != null ? r.sort_order : 0
    };
  }
  function crdPersonToUser(r) {
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      email: r.email || '',
      role: r.role || 'user',
      avatar: r.avatar || '?',
      isBanned: Number(r.is_banned) === 1,
      crdAccessRevoked: Number(r.crd_access_revoked) === 1
    };
  }

  /** null nếu được phép dùng CRD; chuỗi lý do nếu bị chặn */
  function crdPersonBlockedForUse(personId) {
    if (!personId) return 'Không xác định người dùng CRD';
    const row = db.prepare('SELECT is_banned, crd_access_revoked FROM crd_persons WHERE id = ?').get(personId);
    if (!row) return 'Không tìm thấy hồ sơ CRD';
    if (Number(row.crd_access_revoked) === 1) return 'Hồ sơ CRD đã bị gỡ. Liên hệ quản trị để kích hoạt lại.';
    if (Number(row.is_banned) === 1) return 'Tài khoản CRD đang bị tạm khoá.';
    return null;
  }

  /** Người có vai trò CRD gắn cờ Quản trị (vd Admin CRD) — dùng kiểm duyệt kênh chung */
  function crdPersonHasModeratorSlot(personId) {
    if (!personId) return false;
    const p = db.prepare('SELECT role FROM crd_persons WHERE id = ?').get(personId);
    if (!p) return false;
    const slug = String(p.role || '')
      .trim()
      .toLowerCase();
    const rd = db.prepare('SELECT is_admin_slot FROM crd_role_defs WHERE slug = ?').get(slug);
    return rd && Number(rd.is_admin_slot) === 1;
  }
  function crdBookingToClient(r) {
    if (!r) return null;
    return {
      id: r.id,
      machineId: r.machine_id,
      userId: r.person_id,
      date: r.date,
      startH: r.start_h,
      endH: r.end_h,
      purpose: r.purpose || '',
      researchGroup: r.research_group != null ? String(r.research_group) : '',
      status: r.status || 'confirmed'
    };
  }
  function crdChatToClient(r) {
    if (!r) return null;
    return {
      id: r.id,
      fromId: r.from_id,
      toId: r.to_id,
      bookingId: r.booking_id || null,
      msg: r.msg,
      ts: r.ts,
      read: !!r.read_flag,
      isDeleted: !!r.is_deleted
    };
  }

  function crdRoleDefsToClient() {
    return db
      .prepare('SELECT slug, label, sort_order AS sortOrder, is_admin_slot AS isAdminSlot FROM crd_role_defs ORDER BY sort_order ASC, slug ASC')
      .all()
      .map((r) => ({
        slug: r.slug,
        label: r.label,
        sortOrder: r.sortOrder != null ? Number(r.sortOrder) : 0,
        isAdminSlot: !!r.isAdminSlot
      }));
  }

  function crdRoleSlugValid(slug) {
    if (!slug) return false;
    return !!db.prepare('SELECT 1 FROM crd_role_defs WHERE slug = ?').get(slug);
  }

  function crdSeedIfEmpty() {
    const n = db.prepare('SELECT COUNT(*) AS c FROM crd_machines').get();
    if (n && n.c > 0) return;
    const todayStr = new Date().toISOString().split('T')[0];
    const insM = db.prepare(
      'INSERT INTO crd_machines (id,name,type,location,color,avail_from,avail_to,max_hours,description,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)'
    );
    [
      ['m1', 'SEM-7000', 'Kính hiển vi điện tử quét', 'Lab A-01', '#667eea', 8, 20, 4, 'Scanning Electron Microscope', 1],
      ['m2', 'XRD-Pro', 'Máy nhiễu xạ tia X', 'Lab A-02', '#764ba2', 7, 22, 6, 'X-Ray Diffractometer', 2],
      ['m3', 'FTIR-4000', 'Máy quang phổ hồng ngoại', 'Lab B-01', '#4caf88', 8, 18, 3, 'FTIR', 3],
      ['m4', 'TEM-HiRes', 'Kính hiển vi điện tử truyền qua', 'Lab B-02', '#f5a623', 9, 17, 2, 'TEM', 4],
      ['m5', 'Rheometer-AR', 'Máy đo lưu biến', 'Lab C-01', '#e05c6a', 8, 20, 5, 'Rheometer', 5]
    ].forEach(row => insM.run(...row));
    const insP = db.prepare('INSERT INTO crd_persons (id,name,email,role,avatar) VALUES (?,?,?,?,?)');
    [
      ['u_admin', 'Admin CRD', 'admin@crd.edu.vn', 'admin', 'A'],
      ['u1', 'Nguyễn Minh Khoa', 'khoa@crd.edu.vn', 'user', 'K'],
      ['u2', 'Trần Thị Lan', 'lan@crd.edu.vn', 'user', 'L'],
      ['u3', 'Lê Văn Hùng', 'hung@crd.edu.vn', 'user', 'H']
    ].forEach(row => insP.run(...row));
    const insB = db.prepare(
      'INSERT INTO crd_bookings (id,machine_id,person_id,date,start_h,end_h,purpose,status) VALUES (?,?,?,?,?,?,?,?)'
    );
    insB.run('b1', 'm1', 'u1', todayStr, 9, 11, 'Phân tích vật liệu nano', 'confirmed');
    insB.run('b2', 'm2', 'u2', todayStr, 13, 16, 'Phân tích cấu trúc tinh thể', 'confirmed');
    insB.run('b3', 'm3', 'u3', todayStr, 10, 12, 'Nghiên cứu polymer', 'confirmed');
    const ts = Date.now();
    db.prepare('INSERT INTO crd_chats (id,from_id,to_id,booking_id,msg,ts,read_flag) VALUES (?,?,?,?,?,?,?)').run(
      'c1', 'u1', 'u2', 'b2', 'Chào bạn, mình cần dùng XRD lúc 14h–15h, bạn có thể dời sang 15h không?', ts - 3600000, 0
    );
    db.prepare('INSERT INTO crd_chats (id,from_id,to_id,booking_id,msg,ts,read_flag) VALUES (?,?,?,?,?,?,?)').run(
      'c2', 'u2', 'u1', 'b2', 'Mình xem lại lịch nhé.', ts - 1800000, 1
    );
    console.log('[CRD] Đã seed dữ liệu mặc định đặt lịch thiết bị.');
  }
  try {
    crdSeedIfEmpty();
  } catch (e) {
    console.warn('[CRD] Seed:', e.message);
  }

  /** Đặt lịch theo bước 30 phút — migrate bảng cũ INTEGER → REAL */
  function crdEnsureBookingHalfHourColumns() {
    try {
      const cols = db.prepare('PRAGMA table_info(crd_bookings)').all();
      const startCol = cols.find((c) => c.name === 'start_h');
      if (!startCol) return;
      const typ = String(startCol.type || '').toUpperCase();
      if (typ.includes('REAL')) return;

      const migrate = db.transaction(() => {
        db.exec(`
        CREATE TABLE crd_bookings_new (
          id TEXT PRIMARY KEY,
          machine_id TEXT NOT NULL,
          person_id TEXT NOT NULL,
          date TEXT NOT NULL,
          start_h REAL NOT NULL,
          end_h REAL NOT NULL,
          purpose TEXT,
          status TEXT DEFAULT 'confirmed',
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
        const rows = db.prepare('SELECT * FROM crd_bookings').all();
        const ins = db.prepare(
          'INSERT INTO crd_bookings_new (id,machine_id,person_id,date,start_h,end_h,purpose,status,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
        );
        for (const r of rows) {
          ins.run(
            r.id,
            r.machine_id,
            r.person_id,
            r.date,
            Number(r.start_h),
            Number(r.end_h),
            r.purpose,
            r.status,
            r.updated_at
          );
        }
        db.exec('DROP TABLE crd_bookings');
        db.exec('ALTER TABLE crd_bookings_new RENAME TO crd_bookings');
      });
      migrate();
      console.log('[CRD] Đã migrate crd_bookings.start_h/end_h → REAL (hỗ trợ 30 phút)');
    } catch (e) {
      console.warn('[CRD] Migrate booking columns:', e.message);
    }
  }
  try {
    crdEnsureBookingHalfHourColumns();
  } catch (e) {
    console.warn('[CRD] crdEnsureBookingHalfHourColumns:', e.message);
  }

  try {
    db.prepare('ALTER TABLE crd_bookings ADD COLUMN research_group TEXT').run();
  } catch (e) {
    /* cột đã tồn tại */
  }

  /**
   * Cho phép ALTER ... ADD COLUMN chỉ với (bảng, cột, định nghĩa kiểu) đã khai báo — tránh SQL injection nếu sau này gọi từ input.
   * Khi thêm migration cột mới: bổ sung Map tương ứng bên dưới.
   */
  const CRD_ENSURE_COLUMN_ALLOWED = new Map([
    [
      'crd_bookings',
      new Map([
        ['created_at', new Set(['TEXT'])],
        ['research_group', new Set(['TEXT'])],
      ]),
    ],
  ]);

  function crdEnsureColumnIsWhitelisted(tableName, columnName, columnDefSql) {
    const table = String(tableName || '').trim().toLowerCase();
    const col = String(columnName || '').trim().toLowerCase();
    const def = String(columnDefSql || '').trim().replace(/\s+/g, ' ');
    const byTable = CRD_ENSURE_COLUMN_ALLOWED.get(table);
    if (!byTable) {
      console.warn(`[CRD] Ensure column: bảng không nằm trong whitelist: ${tableName}`);
      return false;
    }
    const allowedDefs = byTable.get(col);
    if (!allowedDefs || !allowedDefs.has(def)) {
      console.warn(
        `[CRD] Ensure column: cột hoặc kiểu SQL không được phép: ${table}.${col} — "${def}"`
      );
      return false;
    }
    return true;
  }

  function crdQuoteSqlIdent(name) {
    const s = String(name || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return null;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function crdEnsureColumn(tableName, columnName, columnDefSql) {
    if (!crdEnsureColumnIsWhitelisted(tableName, columnName, columnDefSql)) return false;
    const tableCanon = String(tableName || '').trim().toLowerCase();
    const colCanon = String(columnName || '').trim().toLowerCase();
    const qTable = crdQuoteSqlIdent(tableCanon);
    const qCol = crdQuoteSqlIdent(colCanon);
    if (!qTable || !qCol) {
      console.warn('[CRD] Ensure column: tên bảng/cột không hợp lệ (chỉ chữ, số, gạch dưới).');
      return false;
    }
    const def = String(columnDefSql || '').trim().replace(/\s+/g, ' ');
    try {
      const cols = db.prepare(`PRAGMA table_info(${qTable})`).all();
      const exists = (cols || []).some((c) => String(c.name).toLowerCase() === colCanon);
      if (exists) return true;
      db.prepare(`ALTER TABLE ${qTable} ADD COLUMN ${qCol} ${def}`).run();
      return true;
    } catch (e) {
      console.warn(`[CRD] Ensure column failed: ${tableCanon}.${colCanon}:`, e && e.message ? e.message : String(e));
      return false;
    }
  }

  crdEnsureColumn(
    'crd_bookings',
    'created_at',
    // SQLite chỉ cho phép default kiểu hằng số khi dùng ALTER TABLE ADD COLUMN.
    // Với datetime('now',...) sẽ fail => thêm cột TEXT trống rồi update sau.
    'TEXT'
  );

  crdEnsureColumn(
    'crd_bookings',
    'research_group',
    'TEXT'
  );

  // Nếu bảng đã có created_at (dạng TEXT) nhưng dữ liệu cũ chưa được set, ta điền giá trị hiện tại.
  try {
    db.prepare(
      "UPDATE crd_bookings SET created_at = datetime('now','localtime') WHERE created_at IS NULL OR trim(created_at) = ''"
    ).run();
  } catch (e) {
    /* ignore */
  }
  try {
    db.prepare('ALTER TABLE crd_persons ADD COLUMN is_banned INTEGER DEFAULT 0').run();
  } catch (e) {
    /* cột đã tồn tại */
  }
  try {
    db.prepare('ALTER TABLE crd_persons ADD COLUMN crd_access_revoked INTEGER DEFAULT 0').run();
  } catch (e) {
    /* cột đã tồn tại */
  }
  try {
    db.prepare('ALTER TABLE crd_persons ADD COLUMN user_id INTEGER').run();
  } catch (e) {
    /* cột đã tồn tại */
  }
  try {
    db.prepare('ALTER TABLE users ADD COLUMN is_disabled INTEGER DEFAULT 0').run();
  } catch (e) {
    /* cột đã tồn tại */
  }
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS crd_broadcast_read (
      person_id TEXT PRIMARY KEY,
      last_read_ts INTEGER NOT NULL DEFAULT 0
    );
  `);
  } catch (e) {
    console.warn('[CRD] crd_broadcast_read:', e.message);
  }
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS crd_lab_announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  } catch (e) {
    console.warn('[CRD] crd_lab_announcements:', e.message);
  }
  try {
    db.prepare('ALTER TABLE crd_chats ADD COLUMN is_deleted INTEGER DEFAULT 0').run();
  } catch (e) {
    /* cột đã tồn tại */
  }
  /** CRD — giờ tích lũy & nhật ký bảo trì (migrations/003_crd_maintenance_and_utilization.sql) */
  try {
    db.prepare('ALTER TABLE crd_machines ADD COLUMN accumulated_hours REAL DEFAULT 0').run();
  } catch (e) {
    /* cột đã tồn tại */
  }
  try {
    db.prepare('ALTER TABLE crd_machines ADD COLUMN maintenance_threshold_hours REAL DEFAULT 500').run();
  } catch (e) {
    /* cột đã tồn tại */
  }
  try {
    db.prepare('ALTER TABLE crd_machines ADD COLUMN last_maintenance_date TEXT').run();
  } catch (e) {
    /* cột đã tồn tại */
  }
  try {
    db.prepare('ALTER TABLE crd_machines ADD COLUMN maintenance_notes TEXT').run();
  } catch (e) {
    /* cột đã tồn tại */
  }
  try {
    db.exec(`
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
  `);
  } catch (e) {
    console.warn('[CRD] crd_maintenance_log:', e.message);
  }
  try {
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS crd_trg_booking_accum_after_update
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
    CREATE TRIGGER IF NOT EXISTS crd_trg_booking_accum_after_insert
    AFTER INSERT ON crd_bookings
    FOR EACH ROW
    WHEN NEW.status = 'completed' AND NEW.end_h > NEW.start_h
    BEGIN
      UPDATE crd_machines
      SET accumulated_hours = COALESCE(accumulated_hours, 0) + (NEW.end_h - NEW.start_h)
      WHERE id = NEW.machine_id;
    END;
  `);
  } catch (e) {
    console.warn('[CRD] triggers accumulated_hours:', e.message);
  }
  try {
    db.prepare('ALTER TABLE users ADD COLUMN crd_email_notif INTEGER DEFAULT 1').run();
  } catch (e) {
    /* cột đã tồn tại */
  }
  /** Map: personId → [timestamp] cho rate-limiting gửi tin kênh chung */
  const crdBroadcastRateMap = new Map(); // cleared when server restarts (in-memory)
  const CRD_BROADCAST_RATE_MS = 30_000;  // tối thiểu 30 giây giữa 2 lần gửi
  const CRD_BROADCAST_RATE_BURST = 3;     // cho phép burst 3 tin trước khi áp rate

  return {
    CRD_BROADCAST_RATE_BURST,
    CRD_BROADCAST_RATE_MS,
    crdBookingToClient,
    crdBroadcastRateMap,
    crdChatToClient,
    crdMachineToClient,
    crdPersonBlockedForUse,
    crdPersonHasModeratorSlot,
    crdPersonToUser,
    crdRoleDefsToClient,
    crdRoleSlugValid,
  };
};
