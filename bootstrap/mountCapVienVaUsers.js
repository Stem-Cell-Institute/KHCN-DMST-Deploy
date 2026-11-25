/**
 * Gắn 10 router Đề tài Cấp Viện (/api/cap-vien/*), quản trị Cấp Viện và quản trị users/nhật ký.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../lib/db-bridge');
const {
  CAP_VIEN_PUBLIC_TEMPLATE_CATALOG,
  isAllowedTaskCode,
} = require('../lib/capVienPublicTemplatesCatalog');

module.exports = function mountCapVienAndUsers({
  ALLOWED_EMAIL_DOMAIN,
  BUDGET_TEAM_ROLES,
  CHAIRMAN_EMAIL_CONTROL_DEFAULTS,
  CHAIRMAN_EMAIL_CONTROL_KEY,
  COUNCIL_MEMBER_EMAIL_CONTROL_DEFAULTS,
  COUNCIL_MEMBER_EMAIL_CONTROL_KEY,
  ROLE_LABELS,
  adminOnly,
  app,
  authMiddleware,
  capVienBuildPeriodicSchedule,
  capVienEmailEsc,
  capVienPeriodicFlatFromStepHistory,
  capVienPublicTemplatesFsDir,
  capVienResolvePeriodicAnchor,
  computeCapVienStepActualStats,
  deleteCapVienSubmissionCascade,
  fixFilenameEncoding,
  getCapVienPeriodicReportBundle,
  getCapVienStep7EmailOnComplete,
  getChairmanEmailControls,
  getCouncilMemberEmailControls,
  getNotificationEmails,
  getPhongKhcnEmails,
  insertCapVienHistory,
  insertCapVienPeriodicAdminLog,
  insertCapVienStep2History,
  isSafeEmailFormat,
  pathIsStrictlyInsideResolvedRoot,
  prepareDownloadFileList,
  reqIsMasterAdmin,
  resolveCapVienPublicTemplateStoredFileForUnlink,
  resolveStoredFileFromDb,
  roleIs,
  roleIsAny,
  safeDownload,
  safeUnlinkCapVienStoredFile,
  sanitizeFolderName,
  sendCapVienBudgetApprovedEmail,
  sendCapVienBudgetRevisedSubmittedEmail,
  sendCapVienBudgetRevisionRequestEmail,
  sendCapVienNewSubmissionEmail,
  sendCapVienStep2RevisionEmail,
  sendCapVienStep2ValidatedEmail,
  sendCapVienStep3AssignEmail,
  sendCapVienStep4aNotifyBudgetTeamEmail,
  sendCapVienStep5ChairApprovedRevisionEmail,
  sendCapVienStep5ChairRequestMoreEmail,
  sendCapVienStep5CouncilPassedEmail,
  sendCapVienStep5ReadyEmail,
  sendCapVienStep5RevisionUploadedEmail,
  sendCapVienStep5SecretaryActivityEmail,
  sendCapVienStep5SecretaryRevisionRequestEmail,
  sendCapVienStep6CompletedEmail,
  sendCapVienStep7CompletedEmail,
  sendCapVienSupplementSubmittedEmail,
  sendRoleAssignmentEmail,
  syncMissionsFromCapVien,
  transporter,
  uploadCapVien,
  uploadCapVienPublicTemplate,
  uploadDirCapVien,
  userEmailIsMasterAdmin,
  userHasAnyRole,
  userHasLoginPassword,
  usersWithAnyRole,
  rootDir,
}) {
  app.use('/api', require('../routes/cap-vien/nopHoSoVaDanhMuc')({
    db,
    authMiddleware,
    adminOnly,
    uploadCapVien,
    uploadCapVienPublicTemplate,
    uploadDirCapVien,
    sanitizeFolderName,
    fixFilenameEncoding,
    insertCapVienHistory,
    sendCapVienNewSubmissionEmail,
    CAP_VIEN_PUBLIC_TEMPLATE_CATALOG,
    isAllowedTaskCode,
    resolveStoredFileFromDb,
    capVienPublicTemplatesFsDir,
    pathIsStrictlyInsideResolvedRoot,
    resolveCapVienPublicTemplateStoredFileForUnlink,
    appRootDir: rootDir,
  }));

  // Đợt 6.1: quản trị Đề tài cấp Viện & đồng bộ nhiệm vụ KHCN
  app.use('/api', require('../routes/admin/capVien')({
    db,
    authMiddleware,
    adminOnly,
    syncMissionsFromCapVien,
    getCapVienStep7EmailOnComplete,
    getChairmanEmailControls,
    CHAIRMAN_EMAIL_CONTROL_KEY,
    CHAIRMAN_EMAIL_CONTROL_DEFAULTS,
    getCouncilMemberEmailControls,
    COUNCIL_MEMBER_EMAIL_CONTROL_KEY,
    COUNCIL_MEMBER_EMAIL_CONTROL_DEFAULTS,
  }));

  /** Xem mọi hồ sơ cấp Viện (danh sách + chi tiết + tải): Admin, Viện trưởng, P.KHCN, Hội đồng (kể cả
   * role được cấp qua council_role_grants). Chủ nhiệm chỉ hồ sơ của mình. */
  function capVienRoleSeesAllSubmissions(req) {
    return roleIsAny(req, ['admin', 'vien_truong', 'phong_khcn', 'chu_tich', 'thu_ky', 'thanh_vien']);
  }

  // Đề tài cấp Viện — danh sách & chi tiết hồ sơ (2 endpoint) đã tách sang routes/cap-vien/danhSachVaChiTiet.js.
  app.use('/api', require('../routes/cap-vien/danhSachVaChiTiet')({
    db,
    authMiddleware,
    capVienRoleSeesAllSubmissions,
    computeCapVienStepActualStats,
    getCapVienPeriodicReportBundle,
  }));

  function capVienStep6CanEdit(req) {
    return roleIsAny(req, ['admin', 'phong_khcn', 'thu_ky']);
  }

  function capVienStep6HistoryRoleDb(roleRaw) {
    const r = (roleRaw || '').toLowerCase();
    if (r === 'admin') return 'admin';
    if (r === 'thu_ky') return 'thu_ky';
    return 'phong_khcn';
  }

  // Đề tài cấp Viện — Bước 6, 7, 8 (6 endpoint: quyết định, hợp đồng, đạo đức) đã tách sang routes/cap-vien/quyetDinhHopDongDaoDuc.js.
  app.use('/api', require('../routes/cap-vien/quyetDinhHopDongDaoDuc')({
    db,
    authMiddleware,
    uploadCapVien,
    uploadDirCapVien,
    capVienStep6CanEdit,
    capVienStep6HistoryRoleDb,
    insertCapVienHistory,
    safeUnlinkCapVienStoredFile,
    fixFilenameEncoding,
  }));

  // Đề tài cấp Viện — báo cáo định kỳ (2 endpoint: upload theo kỳ, công cụ admin) đã tách sang routes/cap-vien/baoCaoDinhKy.js.
  app.use('/api', require('../routes/cap-vien/baoCaoDinhKy')({
    db,
    authMiddleware,
    uploadCapVien,
    uploadDirCapVien,
    userHasAnyRole,
    safeUnlinkCapVienStoredFile,
    fixFilenameEncoding,
    insertCapVienHistory,
    capVienPeriodicFlatFromStepHistory,
    insertCapVienPeriodicAdminLog,
    capVienResolvePeriodicAnchor,
    capVienBuildPeriodicSchedule,
  }));

  // Đề tài cấp Viện — đặt/xóa deadline theo bước (1 endpoint) đã tách sang routes/cap-vien/deadline.js.
  app.use('/api', require('../routes/cap-vien/deadline')({ db, authMiddleware }));

  // Đề tài cấp Viện — Bước 5 (họp HĐ, biên bản, chỉnh sửa, thông qua) & danh sách Hội đồng (8 endpoint) đã tách sang routes/cap-vien/hoiDongBuoc5.js.
  app.use('/api', require('../routes/cap-vien/hoiDongBuoc5')({
    db,
    authMiddleware,
    roleIsAny,
    roleIs,
    uploadCapVien,
    uploadDirCapVien,
    insertCapVienHistory,
    sendCapVienStep5SecretaryActivityEmail,
    sendCapVienStep5SecretaryRevisionRequestEmail,
    sendCapVienStep5RevisionUploadedEmail,
    sendCapVienStep5ChairApprovedRevisionEmail,
    sendCapVienStep5ChairRequestMoreEmail,
    sendCapVienStep5CouncilPassedEmail,
    capVienEmailEsc,
    getNotificationEmails,
    safeUnlinkCapVienStoredFile,
    fixFilenameEncoding,
    usersWithAnyRole,
  }));



  // Đề tài cấp Viện — bộ điều phối các bước quy trình (Bước 2, 3, 6, 7, 8, 8a, 9) đã tách sang routes/cap-vien/cacBuocQuyTrinh.js.
  app.use('/api', require('../routes/cap-vien/cacBuocQuyTrinh')({
    db,
    authMiddleware,
    roleIsAny,
    insertCapVienStep2History,
    sendCapVienStep2ValidatedEmail,
    sendCapVienStep2RevisionEmail,
    usersWithAnyRole,
    insertCapVienHistory,
    sendCapVienStep3AssignEmail,
    sendCapVienStep4aNotifyBudgetTeamEmail,
    capVienStep6CanEdit,
    capVienStep6HistoryRoleDb,
    sendCapVienStep6CompletedEmail,
    getNotificationEmails,
    getPhongKhcnEmails,
    getCapVienStep7EmailOnComplete,
    sendCapVienStep7CompletedEmail,
  }));

  // Đề tài cấp Viện — Bước 9 (vật tư/hoá chất) & Bước 11 (đề xuất điều chỉnh) đã tách sang routes/cap-vien/vatTuVaDieuChinh.js.
  app.use('/api', require('../routes/cap-vien/vatTuVaDieuChinh')({
    db,
    authMiddleware,
    roleIsAny,
    capVienStep6HistoryRoleDb,
    insertCapVienHistory,
  }));

  // Bước 4: Phản biện upload phiếu đánh giá (slot 1 hoặc 2) - upload KHONG tu dong "hoan thanh"
  app.use('/api', require('../routes/cap-vien/phanBienVaDuToan')({
    db,
    authMiddleware,
    adminOnly,
    uploadCapVien,
    uploadDirCapVien,
    safeUnlinkCapVienStoredFile,
    fixFilenameEncoding,
    insertCapVienHistory,
    sendCapVienStep5ReadyEmail,
    roleIsAny,
    getNotificationEmails,
    sendCapVienBudgetRevisionRequestEmail,
    sendCapVienBudgetRevisedSubmittedEmail,
    sendCapVienBudgetApprovedEmail,
    sendCapVienStep3AssignEmail,
    sendCapVienStep4aNotifyBudgetTeamEmail,
  }));



  // Đề tài cấp Viện — revert, dev-reset, nộp lại/bổ sung, tải file & xóa (8 endpoint) đã tách sang routes/cap-vien/boSungTaiVaXoa.js.
  app.use('/api', require('../routes/cap-vien/boSungTaiVaXoa')({
    db,
    authMiddleware,
    adminOnly,
    uploadCapVien,
    uploadDirCapVien,
    insertCapVienStep2History,
    safeUnlinkCapVienStoredFile,
    sanitizeFolderName,
    fixFilenameEncoding,
    sendCapVienSupplementSubmittedEmail,
    capVienRoleSeesAllSubmissions,
    prepareDownloadFileList,
    safeDownload,
    deleteCapVienSubmissionCascade,
  }));

  // Đợt 6.2a: quản trị tài khoản & nhật ký hoạt động
  app.use('/api', require('../routes/admin/usersVaNhatKy')({
    db,
    authMiddleware,
    adminOnly,
    userHasLoginPassword,
    userEmailIsMasterAdmin,
    reqIsMasterAdmin,
    isSafeEmailFormat,
    ALLOWED_EMAIL_DOMAIN,
    BUDGET_TEAM_ROLES,
    ROLE_LABELS,
    sendRoleAssignmentEmail,
    transporter,
  }));
};
