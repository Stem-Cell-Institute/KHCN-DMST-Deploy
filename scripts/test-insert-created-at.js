const Database = require('better-sqlite3');

const db = new Database('data/sci-ace.db');
const m = db.prepare('SELECT id FROM crd_machines LIMIT 1').get();
const p = db.prepare('SELECT id FROM crd_persons LIMIT 1').get();

if (!m || !p) {
  console.log('[test] missing crd_machines/crd_persons');
  process.exit(0);
}

const id = '__test_' + Date.now();

try {
  db.prepare(
    `INSERT INTO crd_bookings
      (id,machine_id,person_id,date,start_h,end_h,purpose,status,research_group,created_at)
     VALUES
      (?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`
  ).run(id, m.id, p.id, '2026-04-02', 8, 8.5, 'test', 'confirmed', 'grp');
  console.log('[test] insert ok');
} catch (e) {
  console.log('[test] insert error:', e.message);
} finally {
  try {
    db.prepare('DELETE FROM crd_bookings WHERE id=?').run(id);
  } catch (e) {}
}

