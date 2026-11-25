/**
 * Đồng bộ đề tài Cấp Viện sang Missions, xóa cascade, lưu lịch sử GĐ5 và chuẩn hóa tên file.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const fs = require('fs');
const db = require('../lib/db-bridge');

module.exports = function createCascadeAndFilenameHelpers({
  resolveMissionUploadFileForUnlink,
  resolveStoredFileFromDb,
  uploadDirCapVien,
}) {
  function syncMissionsFromCapVien() {
    // Chỉ dọn missions_hidden «mồ côi» (hồ sơ đã không còn trong cap_vien_submissions).
    // KHÔNG xóa ẩn cho hồ sơ vẫn tồn tại — nếu không, sau khi Admin xóa nhiệm vụ khỏi dashboard
    // (ghi missions_hidden), mỗi lần GET /api/missions sẽ gỡ ẩn và INSERT lại missions từ cap_vien (lỗi «đã xóa mà vẫn hiện»).
    // Khôi phục đầy đủ từ nguồn: POST /api/admin/missions/sync-from-cap-vien (xóa toàn bộ missions_hidden cap_vien).
    try {
      db.prepare(
        `DELETE FROM missions_hidden WHERE source_type = 'cap_vien' AND source_id NOT IN (SELECT id FROM cap_vien_submissions)`
      ).run();
    } catch (e) {
      /* bảng có thể chưa có */
    }
    const rows = db.prepare('SELECT id, title, submittedById, status, createdAt, code FROM cap_vien_submissions').all();
    const hidden = new Set(
      db.prepare("SELECT source_type || ':' || source_id AS k FROM missions_hidden").all().map(r => r.k)
    );
    // Ánh xạ đầy đủ 10 trạng thái thật của cap_vien_submissions (9-step) sang mã trạng thái nhiệm vụ
    // KHCN đã có sẵn nhãn tiếng Việt (MISSION_STATUS_SEARCH_LABELS / getStatusText trong quan-ly-de-tai-co-so.html).
    // Trước đây ASSIGNED và CONTRACTED bị thiếu trong map → rơi về default 'planning' («Lập kế hoạch»),
    // khiến hồ sơ đã ký hợp đồng (gần cuối quy trình) hiển thị như vừa mới nộp; REJECTED cũng bị gộp
    // nhầm vào 'planning' thay vì trạng thái từ chối riêng.
    const statusMap = {
      SUBMITTED: 'planning',              // Mới nộp hồ sơ
      NEED_REVISION: 'planning',          // Thư ký yêu cầu bổ sung hồ sơ
      VALIDATED: 'planning',              // Hồ sơ hợp lệ, chờ phân công phản biện
      // Dùng 'cho_vien_xet_chon' (không phải 'review') vì sidebar quan-ly-de-tai-co-so.html gộp
      // 'review' vào nhóm "Nghiệm thu" (nghiệm thu cuối) — trong khi 3 trạng thái này thực chất là
      // "đang chờ Hội đồng Viện xét/họp", đúng nghĩa nhóm "Chờ xét duyệt".
      ASSIGNED: 'cho_vien_xet_chon',      // Đã phân công phản biện — đang thẩm định
      REVIEWED: 'cho_vien_xet_chon',      // Phản biện xong, chờ họp Hội đồng KHCN
      IN_MEETING: 'cho_vien_xet_chon',    // Đang họp Hội đồng KHCN
      CONDITIONAL: 'da_phe_duyet',        // Hội đồng thông qua (có điều kiện), chờ cấp QĐ chính thức
      APPROVED: 'cho_ky_hop_dong',        // Đã có Quyết định phê duyệt, chờ ký hợp đồng
      CONTRACTED: 'dang_thuc_hien',       // Đã ký hợp đồng — đang triển khai thực hiện
      REJECTED: 'khong_duoc_phe_duyet',   // Bị từ chối / dừng quy trình
    };
    const progressMap = {
      planning: 10,
      cho_vien_xet_chon: 40,
      da_phe_duyet: 55,
      cho_ky_hop_dong: 70,
      dang_thuc_hien: 85,
      khong_duoc_phe_duyet: 0,
    };
    const now = new Date().toISOString().slice(0, 10);
    for (const r of rows) {
      if (hidden.has('cap_vien:' + r.id)) continue;
      const code = r.code || ('DTSCI-' + (r.createdAt || '').slice(0, 4) + '-' + String(r.id).padStart(3, '0'));
      const principal = (r.submittedById ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(r.submittedById) : null);
      const principalName = principal ? (principal.fullname || '') : '';
      const status = statusMap[(r.status || '').toUpperCase()] || 'planning';
      let startDate = (r.createdAt || '').toString().slice(0, 10);
      if (!startDate) startDate = now;
      const end = new Date(startDate);
      end.setFullYear(end.getFullYear() + 2);
      const endDate = end.toISOString().slice(0, 10);
      const progress = progressMap[status] != null ? progressMap[status] : 10;
      const existing = db.prepare('SELECT id FROM missions WHERE source_type = ? AND source_id = ?').get('cap_vien', r.id);
      if (existing) {
        db.prepare(
          `UPDATE missions SET code=?, title=?, principal=?, status=?, start_date=?, end_date=?, progress=? WHERE source_type='cap_vien' AND source_id=?`
        ).run(code, r.title || '', principalName, status, startDate, endDate, progress, r.id);
      } else {
        db.prepare(
          `INSERT INTO missions (code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type) VALUES (?, ?, ?, 'institute', ?, ?, ?, ?, NULL, ?, 'cap_vien')`
        ).run(code, r.title || '', principalName, status, startDate, endDate, progress, r.id);
      }
    }
  }

  /**
   * Xóa đề tài khỏi dashboard và mọi bản ghi phụ thuộc (SQLite foreign_keys = ON).
   * Thứ tự: bảng tham chiếu missions(id) trước, cuối cùng missions.
   */
  function deleteMissionCascade(missionId) {
    const mid = parseInt(missionId, 10);
    if (!mid || isNaN(mid)) throw new Error('INVALID_MISSION_ID');
    const pathsToRemove = [];
    try {
      const mf = db.prepare('SELECT path FROM missions_files WHERE mission_id = ?').all(mid);
      for (const r of mf) {
        if (r && r.path) pathsToRemove.push(String(r.path));
      }
    } catch (e) {
      /* bảng có thể chưa tồn tại trên DB cũ */
    }
    try {
      const hs = db.prepare('SELECT path FROM missions_ho_so_ngoai WHERE mission_id = ?').all(mid);
      for (const r of hs) {
        if (r && r.path) pathsToRemove.push(String(r.path));
      }
    } catch (e) {}
    const stmts = [
      'DELETE FROM lich_su_buoc4a WHERE mission_id = ?',
      'DELETE FROM buoc4a WHERE mission_id = ?',
      'DELETE FROM lich_su_buoc3 WHERE mission_id = ?',
      'DELETE FROM buoc4b WHERE mission_id = ?',
      'DELETE FROM lich_su_doi_nhanh WHERE mission_id = ?',
      'DELETE FROM lich_su_buoc WHERE mission_id = ?',
      'DELETE FROM buoc5_thuyet_minh_ls WHERE mission_id = ?',
      'DELETE FROM buoc5 WHERE mission_id = ?',
      'DELETE FROM buoc6 WHERE mission_id = ?',
      'DELETE FROM missions_files WHERE mission_id = ?',
      'DELETE FROM missions_ho_so_ngoai WHERE mission_id = ?',
      'DELETE FROM missions WHERE id = ?',
    ];
    db.transaction(() => {
      for (const sql of stmts) {
        try {
          db.prepare(sql).run(mid);
        } catch (e) {
          const msg = e && e.message ? String(e.message) : '';
          if (msg.includes('no such table')) continue;
          throw e;
        }
      }
    })();
    for (const rel of pathsToRemove) {
      try {
        const abs = resolveMissionUploadFileForUnlink(rel, mid);
        if (abs) fs.unlinkSync(abs);
      } catch (eUn) {
        /* bỏ qua file không xóa được */
      }
    }
  }

  function resolveCapVienUploadRoot() {
    return path.resolve(uploadDirCapVien);
  }

  /** Chỉ chấp nhận đường dẫn nằm trong uploads-cap-vien — tránh xóa nhầm mã nguồn (server.js, …). */
  function normalizePathUnderCapVienUploads(relOrAbs) {
    const root = resolveCapVienUploadRoot();
    let full = path.isAbsolute(relOrAbs) ? path.resolve(relOrAbs) : resolveStoredFileFromDb(relOrAbs);
    if (!full && relOrAbs != null && String(relOrAbs).trim()) {
      full = path.resolve(uploadDirCapVien, String(relOrAbs).trim());
    }
    if (!full) return null;
    const norm = path.normalize(full);
    if (norm !== root && !norm.startsWith(root + path.sep)) return null;
    return norm;
  }

  function safeUnlinkCapVienStoredFile(storedPath) {
    try {
      const norm = normalizePathUnderCapVienUploads(storedPath);
      if (!norm || !fs.existsSync(norm)) return;
      const st = fs.statSync(norm);
      if (!st.isFile()) return;
      fs.unlinkSync(norm);
    } catch (_) {}
  }

  /**
   * Xóa hoàn toàn một hồ sơ đề tài cấp Viện khỏi toàn hệ thống:
   * — mọi missions (dashboard) trỏ tới cap_vien + source_id (cascade buoc*, missions_files…)
   * — missions_hidden, bảng cap_vien (file, lịch sử, deadline, submission)
   * — thư mục upload trên đĩa (nếu có)
   * Dùng cho Admin: nút Xóa ở Quản lý nhiệm vụ và DELETE /api/cap-vien/submissions/:id
   */
  function deleteCapVienSubmissionCascade(submissionId) {
    const sid = parseInt(submissionId, 10);
    if (!sid || isNaN(sid)) throw new Error('INVALID_CAP_VIEN_SUBMISSION_ID');
    const subRow = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(sid);
    let missionRows = [];
    try {
      missionRows = db.prepare('SELECT id FROM missions WHERE source_type = ? AND source_id = ?').all('cap_vien', sid);
    } catch (e) {
      missionRows = [];
    }
    if (!subRow && (!missionRows || missionRows.length === 0)) {
      try {
        db.prepare('DELETE FROM missions_hidden WHERE source_type = ? AND source_id = ?').run('cap_vien', sid);
      } catch (eH) {}
      throw new Error('CAP_VIEN_SUBMISSION_NOT_FOUND');
    }
    for (const r of missionRows) {
      if (r && r.id) deleteMissionCascade(r.id);
    }
    try {
      db.prepare('DELETE FROM missions_hidden WHERE source_type = ? AND source_id = ?').run('cap_vien', sid);
    } catch (eH) {}
    if (!subRow) {
      return;
    }
    const pathsToRemove = [];
    try {
      const files = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ?').all(sid);
      for (const f of files) {
        if (f && f.path) pathsToRemove.push(String(f.path));
      }
    } catch (e) {}
    const capStmts = [
      'DELETE FROM cap_vien_submission_files WHERE submissionId = ?',
      'DELETE FROM cap_vien_step2_history WHERE submissionId = ?',
      'DELETE FROM cap_vien_submission_history WHERE submissionId = ?',
      'DELETE FROM cap_vien_step_deadlines WHERE submissionId = ?',
      'DELETE FROM cap_vien_submissions WHERE id = ?',
    ];
    db.transaction(() => {
      for (const sql of capStmts) {
        try {
          db.prepare(sql).run(sid);
        } catch (e) {
          const msg = e && e.message ? String(e.message) : '';
          if (msg.includes('no such table')) continue;
          throw e;
        }
      }
    })();
    for (const rel of pathsToRemove) {
      try {
        const norm = normalizePathUnderCapVienUploads(rel);
        if (!norm || !fs.existsSync(norm)) continue;
        const st = fs.statSync(norm);
        if (st.isFile()) fs.unlinkSync(norm);
      } catch (eUn) {}
    }
    let submissionDirSafe = null;
    const capRoot = resolveCapVienUploadRoot();
    const expectedBase = 'submission_' + String(sid);
    for (const rel of pathsToRemove) {
      const fileNorm = normalizePathUnderCapVienUploads(rel);
      if (!fileNorm) continue;
      let dir = path.dirname(fileNorm);
      while (dir && dir.length >= capRoot.length) {
        if (!dir.startsWith(capRoot + path.sep) && dir !== capRoot) break;
        if (path.basename(dir) === expectedBase) {
          submissionDirSafe = normalizePathUnderCapVienUploads(dir);
          break;
        }
        if (dir === capRoot) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      if (submissionDirSafe) break;
    }
    if (submissionDirSafe && fs.existsSync(submissionDirSafe)) {
      try {
        fs.rmSync(submissionDirSafe, { recursive: true });
      } catch (eRm) {}
    }
  }

  function insertGd5History(submissionId, actionType, performedById, fileFieldName, originalFileName, label) {
    const performedAt = new Date().toISOString();
    const u = performedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(performedById) : null;
    const performedByName = u ? (u.fullname || u.email || '') : '';
    db.prepare(
      'INSERT INTO submission_gd5_history (submissionId, actionType, performedAt, performedById, performedByName, fileFieldName, originalFileName, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(submissionId, actionType, performedAt, performedById || null, performedByName, fileFieldName || null, originalFileName || null, label || null);
  }

  // Sửa tên file bị bể dấu: trình duyệt gửi UTF-8 nhưng Node đọc header theo Latin-1 → chuyển lại UTF-8
  function fixFilenameEncoding(name) {
    if (!name || typeof name !== 'string') return name || '';
    try {
      return Buffer.from(name, 'latin1').toString('utf8');
    } catch (e) {
      return name;
    }
  }

  // Tên thư mục an toàn từ họ tên (loại bỏ ký tự đặc biệt, khoảng trắng → gạch dưới)
  function sanitizeFolderName(name) {
    if (!name || typeof name !== 'string') return 'Nghien_cuu_vien';
    return name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_\-]/g, '')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'Nghien_cuu_vien';
  }

  return {
    deleteCapVienSubmissionCascade,
    deleteMissionCascade,
    fixFilenameEncoding,
    insertGd5History,
    safeUnlinkCapVienStoredFile,
    sanitizeFolderName,
    syncMissionsFromCapVien,
  };
};
