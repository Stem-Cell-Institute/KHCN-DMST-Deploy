'use strict';

/**
 * services/missionOwnership.js
 * Xác định một người dùng có phải CHỦ NHIỆM của đề tài hay không (nợ kỹ thuật #9).
 *
 * Khó ở chỗ `missions.principal` là CHUỖI TÊN, không phải khóa ngoại tới `users`. Hệ thống có hai
 * nguồn dữ liệu, nên dùng hai cách và coi là chủ nhiệm nếu một trong hai đúng:
 *
 *  1. Đề tài cấp Viện (`source_type = 'cap_vien'`): người nộp hồ sơ
 *     (`cap_vien_submissions.submittedById`) là chủ nhiệm. Đây là khóa thật nên chắc chắn nhất, và
 *     đúng với cách `buoc4b/ket-qua` đang chọn người nhận email "chủ nhiệm".
 *  2. Còn lại: so họ tên. `POST /api/missions` tự đặt `principal = họ tên người tạo`, nên so
 *     `principal` với `users.fullname` đúng là phép ngược lại của chính cách hệ thống sinh dữ liệu.
 *
 * Giới hạn đã biết (chủ ý chấp nhận, ghi ở readme/REFACTOR-PROGRESS.md):
 *  - Tên khác nhau (gõ cụt như "Phạm Văn", hoặc chủ nhiệm không có tài khoản) thì KHÔNG khớp:
 *    người đó không upload được, chỉ Thư ký Hội đồng / Admin upload hộ. Từ chối nhầm an toàn hơn
 *    cho nhầm.
 *  - Hai người trùng họ tên đầy đủ (sau khi bỏ dấu) sẽ khớp cùng một đề tài.
 */

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Chuẩn hoá họ tên để so sánh: bỏ dấu, đ→d, chữ thường, gộp khoảng trắng.
 * Bỏ dấu để chịu được cách đặt dấu khác nhau ("Thuỷ" / "Thủy") và Unicode NFC / NFD.
 */
function normalizePersonName(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param db       kết nối DB (better-sqlite3 hoặc lớp bọc tương đương: .prepare(sql).get(...))
 * @param mission  hàng `missions` (cần `principal`, `source_type`, `source_id`)
 * @param user     `req.user` (cần `id`, `fullname`)
 */
function isMissionPrincipal(db, mission, user) {
  if (!mission || !user) return false;

  if (mission.source_type === 'cap_vien' && mission.source_id && user.id != null) {
    try {
      const sub = db.prepare('SELECT submittedById FROM cap_vien_submissions WHERE id = ?').get(mission.source_id);
      if (sub && sub.submittedById != null && Number(sub.submittedById) === Number(user.id)) return true;
    } catch (_) {
      /* bảng không có / lỗi truy vấn: rơi xuống so tên, KHÔNG mở quyền */
    }
  }

  const principal = normalizePersonName(mission.principal);
  const name = normalizePersonName(user.fullname);
  // Hai chuỗi rỗng không được coi là "khớp nhau".
  return principal !== '' && name !== '' && principal === name;
}

module.exports = { normalizePersonName, isMissionPrincipal };
