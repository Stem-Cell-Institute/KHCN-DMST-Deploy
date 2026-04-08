/**
 * Cooperation agreements: open-ended MOU (no fixed expiry), staff notes, recorded termination + optional scan.
 * Idempotent ALTERs for existing SQLite DBs.
 * @param {import('better-sqlite3').Database} db
 */
function runCooperationThoaThuanOpenTermMigration(db) {
  const statements = [
    'ALTER TABLE cooperation_thoa_thuan ADD COLUMN no_fixed_term INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE cooperation_thoa_thuan ADD COLUMN staff_notes TEXT',
    'ALTER TABLE cooperation_thoa_thuan ADD COLUMN terminated_at TEXT',
    'ALTER TABLE cooperation_thoa_thuan ADD COLUMN termination_scan_path TEXT',
    'ALTER TABLE cooperation_thoa_thuan ADD COLUMN termination_scan_name TEXT',
    'ALTER TABLE cooperation_thoa_thuan ADD COLUMN termination_uploaded_at TEXT',
  ];
  for (const sql of statements) {
    try {
      db.prepare(sql).run();
    } catch (e) {
      /* column already exists */
    }
  }
}

module.exports = runCooperationThoaThuanOpenTermMigration;
