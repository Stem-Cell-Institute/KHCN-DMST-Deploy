/**
 * Kiểm tra quyền xem tài liệu/video thiết bị theo access_level.
 *
 * @param {object} req — request Express (req.user có thể null nếu chưa đăng nhập)
 * @param {{ access_level?: string }} media — document hoặc video row
 * @param {{ department_id?: string|null }} equipmentRow — hàng equipments
 * @param {import('better-sqlite3').Database} db
 * @returns {{ ok: boolean, status?: number }}
 */
function checkEquipmentDocAccess(req, media, equipmentRow, db) {
  if (!media) return { ok: false, status: 404 };
  const level = String(media.access_level || 'internal').toLowerCase();
  if (level === 'public') return { ok: true };

  if (!req.user || req.user.id == null) {
    return { ok: false, status: 401 };
  }
  if (level === 'institute') {
    return { ok: true };
  }

  const role = String(req.user.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager' || role === 'phong_khcn') {
    return { ok: true };
  }

  let userDept = req.user.department_id;
  if (userDept == null && db) {
    try {
      const u = db.prepare('SELECT department_id FROM users WHERE id = ?').get(req.user.id);
      if (u) userDept = u.department_id;
    } catch (_) {
      /* ignore */
    }
  }
  const eqDept = equipmentRow && equipmentRow.department_id;
  if (userDept != null && eqDept != null && String(userDept) === String(eqDept)) {
    return { ok: true };
  }
  return { ok: false, status: 403 };
}

module.exports = { checkEquipmentDocAccess };
