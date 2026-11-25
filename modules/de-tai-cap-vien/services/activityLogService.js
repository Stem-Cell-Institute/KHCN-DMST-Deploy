const db = require('../db/db');

/**
 * Ghi nhật ký hoạt động nghiệp vụ vào bảng nckh_activity_logs.
 * Không throw lỗi ra ngoài để tránh làm gián đoạn luồng nghiệp vụ chính.
 */
async function logActivity({
  actorName = 'Hệ thống',
  actorRole = 'SYSTEM',
  action,
  entityType,
  entityId = null,
  projectId = null,
  summary,
  details = null
}) {
  try {
    const detailsStr = details
      ? (typeof details === 'string' ? details : JSON.stringify(details))
      : null;

    await db.run(
      `INSERT INTO nckh_activity_logs (
        actor_name, actor_role, action, entity_type, entity_id, project_id, summary, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actorName || 'Hệ thống',
        actorRole || 'SYSTEM',
        action,
        entityType,
        entityId,
        projectId,
        summary,
        detailsStr
      ]
    );
    return true;
  } catch (err) {
    console.error('Lỗi ghi nckh_activity_logs:', err.message);
    return false;
  }
}

/**
 * Helper ghi log tự động lấy thông tin người thao tác từ req.user.
 */
async function logFromRequest(req, payload) {
  const actorName = (req && req.user && req.user.fullname) ? req.user.fullname : 'Hệ thống';
  const actorRole = (req && req.user && req.user.role) ? req.user.role : 'SYSTEM';
  return logActivity({
    actorName,
    actorRole,
    ...payload
  });
}

/**
 * Truy vấn danh sách nhật ký hoạt động (có lọc theo projectId, entityType, action).
 */
async function getActivityLogs({ projectId = null, entityType = null, action = null, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const args = [];

  if (projectId) {
    conditions.push('l.project_id = ?');
    args.push(Number(projectId));
  }
  if (entityType) {
    conditions.push('l.entity_type = ?');
    args.push(String(entityType).toUpperCase());
  }
  if (action) {
    conditions.push('l.action = ?');
    args.push(String(action).toUpperCase());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const rows = await db.all(
    `SELECT l.*, p.code AS project_code, p.title AS project_title
     FROM nckh_activity_logs l
     LEFT JOIN nckh_projects p ON l.project_id = p.id
     ${whereClause}
     ORDER BY datetime(l.created_at) DESC, l.id DESC
     LIMIT ? OFFSET ?`,
    [...args, safeLimit, safeOffset]
  );

  return rows;
}

module.exports = {
  logActivity,
  logFromRequest,
  getActivityLogs
};
