/**
 * Khởi tạo tài khoản admin mặc định (nếu chưa có), nâng cấp master admin và chuẩn hóa meetingDecisionFile cũ.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const bcrypt = require('bcryptjs');
const db = require('../lib/db-bridge');

module.exports = function seedAdminAndFixMeetingFiles({ ADMIN_EMAIL, insertGd5History }) {
  const adminExists = db.prepare('SELECT 1 FROM users WHERE lower(trim(email)) = ?').get(ADMIN_EMAIL.toLowerCase());
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (email, password, fullname, role) VALUES (?, ?, ?, ?)').run(
      ADMIN_EMAIL.toLowerCase(),
      hash,
      'Admin',
      'admin'
    );
    console.log('Đã tạo tài khoản Admin mặc định: ' + ADMIN_EMAIL + ' / mật khẩu: admin123 (vui lòng đổi sau)');
  }
  // Luôn đảm bảo super-admin có role admin (phòng trường hợp bị đổi role trong DB)
  try {
    const r = db
      .prepare("UPDATE users SET role = 'admin' WHERE lower(trim(email)) = ? AND lower(trim(role)) != 'admin'")
      .run(ADMIN_EMAIL.toLowerCase());
    if (r.changes > 0) console.log('[Admin] Đã khôi phục vai trò admin cho ' + ADMIN_EMAIL);
  } catch (e) { /* ignore */ }
  // Đồng bộ: sinhnguyen@sci.edu.vn = NCV (researcher), không admin; tên hiển thị đầy đủ «Nguyễn Trường Sinh»
  try {
    const r = db
      .prepare(
        `UPDATE users SET
         role = 'researcher',
         fullname = CASE
           WHEN lower(trim(coalesce(fullname, ''))) IN ('admin', 'administrator', 'quản trị', 'quan tri', 'sinh') THEN 'Nguyễn Trường Sinh'
           WHEN trim(coalesce(fullname, '')) = '' THEN 'Nguyễn Trường Sinh'
           ELSE fullname
         END
       WHERE lower(trim(email)) = ?`
      )
      .run('sinhnguyen@sci.edu.vn');
    if (r.changes > 0) {
      console.log('[Users] Đã đồng bộ sinhnguyen@sci.edu.vn → researcher (tên: Nguyễn Trường Sinh).');
    }
  } catch (e) {
    /* ignore */
  }

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
};
