/**
 * Khởi tạo thư mục uploads và helper kiểm tra đường dẫn an toàn khi tải/xóa file.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const fs = require('fs');
const appPaths = require('./appPaths');

module.exports = function createStoragePathHelpers({ rootDir }) {
  fs.mkdirSync(appPaths.sqliteDataDir(), { recursive: true });
  const uploadDir = appPaths.uploadsRoot();
  const uploadDirCapVien = appPaths.uploadsCapVienRoot();
  const capVienPublicTemplatesFsDir = appPaths.capVienPublicTemplatesDir();
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(uploadDirCapVien, { recursive: true });
  fs.mkdirSync(capVienPublicTemplatesFsDir, { recursive: true });
  for (const sub of ['htqt-doan-ra', 'htqt-doan-vao', 'htqt-mou', 'htqt-ytnn', 'events', 'htqt-thoa-thuan', 'dms', 'conference']) {
    fs.mkdirSync(path.join(uploadDir, sub), { recursive: true });
  }
  fs.mkdirSync(path.join(rootDir, 'templates', 'events'), { recursive: true });
  if (appPaths.appDataDir) {
    console.log('[paths] APP_DATA_DIR=' + appPaths.appDataDir + ' | DB dir=' + appPaths.sqliteDataDir() + ' | uploads=' + uploadDir);
  }

  // --- Giới hạn đường dẫn khi xóa file/thư mục (chống path traversal / xóa nhầm mã nguồn) ---
  const RESOLVED_UPLOADS_ROOT = path.resolve(uploadDir);
  const RESOLVED_CAP_VIEN_UPLOADS_ROOT = path.resolve(uploadDirCapVien);

  /**
   * Chuỗi đường dẫn lưu trong CSDL → file thật trên đĩa.
   * Hỗ trợ tiền tố uploads/ và uploads-cap-vien/ (cũ: relative từ thư mục code).
   * Lưu ý: bản cũ dùng path.relative(__dirname, file) nên có thể là
   * "data/uploads-cap-vien/..." — phải nhận diện uploads-cap-vien/ ở bất kỳ vị trí nào trong chuỗi.
   * Tương tự với uploads/ (vd. data/uploads/htqt-...) khi APP_DATA_DIR tách khỏi thư mục code.
   * - uploads-cap-vien: có thể xuất hiện ở đầu chuỗi hoặc sau ../ (code /opt/app, file ở APP_DATA_DIR).
   * - public-templates/...: lưu mới (relative tới uploads-cap-vien).
   * - uploads/: thư mục upload chung (missions, htqt, …).
   */
  function resolveStoredFileFromDb(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (path.isAbsolute(s)) return path.normalize(path.resolve(s));
    let n = s.replace(/\\/g, '/');
    if (n.startsWith('./')) n = n.slice(2);
    const capMarker = 'uploads-cap-vien/';
    const capIdx = n.toLowerCase().indexOf(capMarker);
    if (capIdx !== -1) {
      const rest = n.slice(capIdx + capMarker.length);
      return path.normalize(path.resolve(uploadDirCapVien, rest));
    }
    const upMarker = 'uploads/';
    const upIdx = n.toLowerCase().indexOf(upMarker);
    if (upIdx !== -1) {
      const rest = n.slice(upIdx + upMarker.length);
      return path.normalize(path.resolve(uploadDir, rest));
    }
    // Legacy: một số bản ghi sai chỉ còn nhánh public-templates/... (resolve cũ gắn nhầm uploads/)
    if (n.startsWith('public-templates/')) {
      return path.normalize(path.resolve(uploadDirCapVien, n));
    }

    if (n.startsWith('uploads/')) {
      return path.normalize(path.resolve(uploadDir, n.slice('uploads/'.length)));
    }
    return path.normalize(path.resolve(uploadDir, n));
  }

  /** File vừa ghi dưới uploadDir → chuỗi lưu CSDL dạng uploads/... (không phụ thuộc __dirname / APP_DATA_DIR). */
  function storedUploadsPathForDatabase(absoluteFilePath) {
    const abs = path.resolve(absoluteFilePath);
    const rel = path.relative(uploadDir, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return 'uploads/' + rel.split(path.sep).join('/');
    }
    return path.relative(rootDir, abs).split(path.sep).join('/');
  }

  function pathIsStrictlyInsideResolvedRoot(resolvedRootAbs, candidateAbs) {
    const root = path.resolve(resolvedRootAbs);
    const cand = path.resolve(candidateAbs);
    if (cand === root) return false;
    const rel = path.relative(root, cand);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  function downloadPathIsAllowed(normAbs) {
    const norm = path.resolve(normAbs);
    return (
      pathIsStrictlyInsideResolvedRoot(RESOLVED_UPLOADS_ROOT, norm) ||
      pathIsStrictlyInsideResolvedRoot(RESOLVED_CAP_VIEN_UPLOADS_ROOT, norm)
    );
  }

  /** Kiểm tra path từ DB trước khi res.download (defense-in-depth). Trả { norm } hoặc { err: 403|404 }. */
  function normalizeAndCheckDownloadPath(storedPath) {
    const raw = storedPath == null ? '' : String(storedPath).trim();
    if (!raw) return { err: 404 };
    const norm = resolveStoredFileFromDb(raw);
    if (!norm) return { err: 404 };
    if (!downloadPathIsAllowed(norm)) return { err: 403 };
    try {
      if (!fs.existsSync(norm) || !fs.statSync(norm).isFile()) return { err: 404 };
    } catch (_) {
      return { err: 404 };
    }
    return { norm };
  }

  function safeDownload(res, storedPath, downloadName) {
    const r = normalizeAndCheckDownloadPath(storedPath);
    if (r.err === 403) return res.status(403).json({ message: 'Truy cập bị từ chối' });
    if (r.err) return res.status(404).json({ message: 'File không tồn tại' });
    return res.download(r.norm, downloadName);
  }

  /** Chuẩn bị danh sách file cho ZIP; đã gửi lỗi thì trả null. */
  function prepareDownloadFileList(res, files) {
    const out = [];
    for (let i = 0; i < (files || []).length; i++) {
      const f = files[i];
      const r = normalizeAndCheckDownloadPath(f && f.path);
      if (r.err === 403) {
        res.status(403).json({ message: 'Truy cập bị từ chối' });
        return null;
      }
      if (r.err) {
        res.status(404).json({ message: 'File không tồn tại' });
        return null;
      }
      out.push({ norm: r.norm, originalName: f.originalName });
    }
    return out;
  }

  /** Chỉ file trong uploads/missions/<missionId>/ (đúng cách lưu khi upload). */
  function resolveMissionUploadFileForUnlink(storedPath, missionId) {
    const mid = parseInt(missionId, 10);
    if (!Number.isFinite(mid) || mid <= 0) return null;
    const raw = String(storedPath || '').trim();
    if (!raw) return null;
    const missionRoot = path.resolve(uploadDir, 'missions', String(mid));
    const full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(uploadDir, raw);
    const norm = path.normalize(full);
    if (!pathIsStrictlyInsideResolvedRoot(missionRoot, norm)) return null;
    try {
      if (!fs.existsSync(norm) || !fs.statSync(norm).isFile()) return null;
    } catch (_) {
      return null;
    }
    return norm;
  }

  /** Chỉ thư mục .../submission_<id>/ nằm trong uploads/ — tránh rmSync nhầm project root. */
  function resolveGdSubmissionDirForRmSync(submissionId, sampleFilePathFromDb) {
    const sid = parseInt(submissionId, 10);
    if (!Number.isFinite(sid) || sid <= 0) return null;
    const raw = String(sampleFilePathFromDb || '').trim();
    if (!raw) return null;
    const fileAbs = path.isAbsolute(raw) ? path.resolve(raw) : resolveStoredFileFromDb(raw);
    if (!fileAbs || !pathIsStrictlyInsideResolvedRoot(RESOLVED_UPLOADS_ROOT, fileAbs)) return null;
    const dir = path.dirname(fileAbs);
    if (path.basename(dir) !== 'submission_' + sid) return null;
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
    } catch (_) {
      return null;
    }
    return dir;
  }

  function resolveEventUploadFileForUnlink(storedPath, eventId) {
    const eid = parseInt(eventId, 10);
    if (!Number.isFinite(eid) || eid <= 0) return null;
    const raw = String(storedPath || '').trim();
    if (!raw) return null;
    const eventRoot = path.resolve(uploadDir, 'events', String(eid));
    const full = resolveStoredFileFromDb(raw);
    if (!full) return null;
    const norm = full;
    if (!pathIsStrictlyInsideResolvedRoot(eventRoot, norm)) return null;
    try {
      if (!fs.existsSync(norm) || !fs.statSync(norm).isFile()) return null;
    } catch (_) {
      return null;
    }
    return norm;
  }

  function coopHtqtVanBanUnlinkRoots() {
    return [
      path.resolve(uploadDir, 'htqt-doan-ra'),
      path.resolve(uploadDir, 'htqt-doan-vao'),
      path.resolve(uploadDir, 'htqt-mou'),
      path.resolve(uploadDir, 'htqt-ytnn'),
      path.resolve(uploadDir, 'htqt-thoa-thuan'),
    ];
  }

  function resolveCoopVanBanWordFileForUnlink(storedPath) {
    const raw = String(storedPath || '').trim();
    if (!raw) return null;
    const full = resolveStoredFileFromDb(raw);
    if (!full) return null;
    const norm = full;
    for (const root of coopHtqtVanBanUnlinkRoots()) {
      if (pathIsStrictlyInsideResolvedRoot(root, norm)) {
        try {
          if (fs.existsSync(norm) && fs.statSync(norm).isFile()) return norm;
        } catch (_) {
          return null;
        }
        return null;
      }
    }
    return null;
  }

  function resolveCapVienPublicTemplateStoredFileForUnlink(storedPath) {
    const root = path.resolve(capVienPublicTemplatesFsDir);
    const raw = String(storedPath || '').trim();
    if (!raw) return null;
    const full = resolveStoredFileFromDb(raw);
    if (!full) return null;
    const norm = full;
    if (!pathIsStrictlyInsideResolvedRoot(root, norm)) return null;
    try {
      if (fs.existsSync(norm) && fs.statSync(norm).isFile()) return norm;
    } catch (_) {
      return null;
    }
    return null;
  }

  return {
    capVienPublicTemplatesFsDir,
    normalizeAndCheckDownloadPath,
    pathIsStrictlyInsideResolvedRoot,
    prepareDownloadFileList,
    resolveCapVienPublicTemplateStoredFileForUnlink,
    resolveCoopVanBanWordFileForUnlink,
    resolveEventUploadFileForUnlink,
    resolveGdSubmissionDirForRmSync,
    resolveMissionUploadFileForUnlink,
    resolveStoredFileFromDb,
    safeDownload,
    storedUploadsPathForDatabase,
    uploadDir,
    uploadDirCapVien,
  };
};
