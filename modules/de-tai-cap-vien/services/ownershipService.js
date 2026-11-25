/**
 * Kiểm tra quyền sở hữu đề tài cho vai trò Chủ nhiệm đề tài (CHU_NHIEM).
 * Cơ chế khớp 2 lớp:
 *   - Ưu tiên 1: Khớp chính xác theo `leader_email` (không phân biệt hoa/thường).
 *   - Ưu tiên 2 (dự phòng cho dữ liệu cũ chưa có leader_email): Khớp theo `leader_name`
 *     đã chuẩn hóa tiếng Việt (bỏ dấu, bỏ học hàm GS/PGS/TS/ThS/CN..., bỏ khoảng trắng thừa).
 */

function normalizeVietnameseName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/\b(gs|pgs|ts|ths|cn|ks|bs|dr|mr|ms|mrs|prof)\b\.?/gi, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isRestrictedToOwnProjects(user) {
  return !!(user && user.role === 'CHU_NHIEM');
}

function isProjectOwnedByUser(project, user) {
  if (!project || !user) return false;
  if (!isRestrictedToOwnProjects(user)) return true;

  // Khi Admin đang dùng chế độ "Đổi vai trò (Xem thử)" với 1 CNĐT cụ thể, khớp theo tên CNĐT đang xem thử
  if (user.is_role_preview) {
    const previewLeader = normalizeVietnameseName(user.leader_name || user.fullname);
    const projLeader = normalizeVietnameseName(project.leader_name);
    return !!(previewLeader && projLeader && projLeader === previewLeader);
  }

  // Ưu tiên 1: khớp chính xác email nếu đề tài đã gắn leader_email
  const projEmail = String(project.leader_email || '').trim().toLowerCase();
  const userEmail = String(user.email || '').trim().toLowerCase();
  if (projEmail) {
    return !!userEmail && projEmail === userEmail;
  }

  // Ưu tiên 2: khớp tên đã chuẩn hóa tiếng Việt
  const projLeader = normalizeVietnameseName(project.leader_name);
  const userLeader = normalizeVietnameseName(user.leader_name || user.fullname);
  if (!projLeader || !userLeader) return false;
  return projLeader === userLeader;
}

function filterProjectsForUser(projects, user) {
  if (!Array.isArray(projects)) return [];
  if (!isRestrictedToOwnProjects(user)) return projects;
  return projects.filter((p) => isProjectOwnedByUser(p, user));
}

module.exports = {
  normalizeVietnameseName,
  isRestrictedToOwnProjects,
  isProjectOwnedByUser,
  filterProjectsForUser,
};
