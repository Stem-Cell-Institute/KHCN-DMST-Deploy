/**
 * Đồng bộ đề tài Cấp Viện và gắn toàn bộ router Nhiệm vụ KHCN (/api/missions*), biểu mẫu ACE, cấu hình Trang chủ & cài đặt.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../lib/db-bridge');

module.exports = function mountMissionsAndHomepageConfig({
  HOMEPAGE_MODULES_DEFAULT,
  PORT,
  adminOnly,
  adminOrPhongKhcn,
  adminOrPhongKhcnMissionEditor,
  app,
  authMiddleware,
  canUserAccessMissionDetail,
  canUserAccessMissionHoSoNgoai,
  chuTichOrAdmin,
  computeNhanhFromLevel,
  deleteCapVienSubmissionCascade,
  deleteMissionCascade,
  getChairmanEmail,
  getNotificationEmails,
  getSmtpFrom,
  insertUserActivityLog,
  isChairmanEmailEnabled,
  isSafeEmailFormat,
  masterAdminOnly,
  normalizeAndCheckDownloadPath,
  pathIsStrictlyInsideResolvedRoot,
  resolveMissionStatusInput,
  roleIsAny,
  syncMissionsFromCapVien,
  thuyKyOrAdmin,
  transporter,
  upload,
  uploadDir,
}) {
  syncMissionsFromCapVien();

  // Nhóm lõi (thống kê, danh sách, đăng ký mới) đã tách sang routes/missions/core.js.
  // Mount ĐÚNG TẠI VỊ TRÍ CŨ: phải trước '/api/missions/:id' bên dưới, vì handler đó
  // trả 400 «ID không hợp lệ» và không gọi next() — '/missions/stats' đăng ký sau nó
  // sẽ chết im lặng.
  app.use('/api', require('../routes/missions/core')({
    db,
    authMiddleware,
    transporter,
    PORT,
    syncMissionsFromCapVien,
    getSmtpFrom,
    getNotificationEmails,
  }));

  // Hồ sơ đăng ký + duyệt Bước 2–3 đã tách sang routes/missions/hoSo.js.
  // Mount ĐÚNG TẠI VỊ TRÍ CŨ: vẫn phải trước '/api/missions/:id' bên dưới.
  app.use('/api', require('../routes/missions/hoSo')({
    db,
    authMiddleware,
    thuyKyOrAdmin,
    chuTichOrAdmin,
    adminOrPhongKhcn,
    transporter,
    PORT,
    canUserAccessMissionHoSoNgoai,
    computeNhanhFromLevel,
    getChairmanEmail,
    getNotificationEmails,
    getSmtpFrom,
    isChairmanEmailEnabled,
    normalizeAndCheckDownloadPath,
  }));

  // Duyệt Bước 4a/4b/5/6 đã tách sang routes/missions/pheDuyet.js.
  // Mount ĐÚNG TẠI VỊ TRÍ CŨ: vẫn phải trước '/api/missions/:id' bên dưới.
  app.use('/api', require('../routes/missions/pheDuyet')({
    db,
    authMiddleware,
    thuyKyOrAdmin,
    transporter,
    upload,
    PORT,
    roleIsAny,
    getNotificationEmails,
    getSmtpFrom,
  }));

  // Danh sách chờ CT HĐ xét duyệt đã tách sang routes/missions/choXetDuyet.js.
  // Mount ĐÚNG TẠI VỊ TRÍ CŨ — phải trước missionsExport và missionsChiTiet bên dưới.
  app.use('/api', require('../routes/missions/choXetDuyet')({
    db,
    authMiddleware,
    roleIsAny,
  }));

  // Đợt 6.3a: quản trị sửa/xóa Nhiệm vụ KHCN
  app.use('/api', require('../routes/admin/missionsQuanTri')({
    db,
    authMiddleware,
    adminOrPhongKhcnMissionEditor,
    masterAdminOnly,
    resolveMissionStatusInput,
    deleteCapVienSubmissionCascade,
    deleteMissionCascade,
    insertUserActivityLog,
  }));

  // CSV helper: escape field for CSV (quote if contains comma, newline or quote)
  function csvEscape(s) {
    if (s == null) return '';
    const str = String(s).trim();
    if (/[,"\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
    return str;
  }

  // Xuất dữ liệu nhiệm vụ (CSV / Excel / báo cáo thống kê) — xem routes/missions/export.js.
  // Phải mount TRƯỚC handler '/api/missions/:id' bên dưới, nếu không 'export',
  // 'export-excel', 'report-excel'… sẽ bị bắt nhầm thành :id.
  app.use('/api', require('../routes/missions/export')({
    db,
    authMiddleware,
    adminOnly,
    csvEscape,
    syncMissionsFromCapVien,
    insertUserActivityLog,
  }));

  // Chi tiết đề tài + hồ sơ ngoài Viện + file sản phẩm đã tách sang
  // routes/missions/chiTiet.js. Router này chứa '/missions/:id' nên BẮT BUỘC mount
  // SAU missionsCore, missionsChoXetDuyet và missionsExport ở trên — nếu không,
  // '/api/missions/export', '/stats', '/cho-ct-hd-*' sẽ bị :id nuốt thành 400.
  app.use('/api', require('../routes/missions/chiTiet')({
    db,
    authMiddleware,
    upload,
    uploadDir,
    syncMissionsFromCapVien,
    canUserAccessMissionDetail,
    canUserAccessMissionHoSoNgoai,
    normalizeAndCheckDownloadPath,
  }));

  // Mẫu hồ sơ đăng ký đề tài ngoài Viện — Admin upload, User download
  const TEMPLATE_TYPES = ['thuyet_minh_chi_tiet', 'van_ban_xin_phep_vien_truong'];
  const TEMPLATE_LABELS = { thuyet_minh_chi_tiet: 'Mẫu Thuyết minh chi tiết', van_ban_xin_phep_vien_truong: 'Mẫu Văn bản xin phép Viện trưởng' };

  // Mẫu hồ sơ đăng ký đề tài ngoài Viện — xem routes/missions/templates.js.
  app.use('/api', require('../routes/missions/templates')({
    db,
    authMiddleware,
    adminOnly,
    upload,
    uploadDir,
    templateTypes: TEMPLATE_TYPES,
    templateLabels: TEMPLATE_LABELS,
    pathIsStrictlyInsideResolvedRoot,
  }));

  // Mẫu hồ sơ SCI-ACE (Hội đồng đạo đức trên động vật) — Admin/Thư ký Hội đồng upload, mọi người đăng nhập được download
  const { ACE_TEMPLATE_BY_TYPE, ACE_TEMPLATE_TYPES, aceCanManageTemplates } = require('../routes/core/aceTemplates')({
    app,
    authMiddleware,
    pathIsStrictlyInsideResolvedRoot,
    roleIsAny,
    uploadDir,
  });

  // Đợt 6.3b: quản trị mẫu ACE & import/thêm thủ công Nhiệm vụ KHCN
  app.use('/api', require('../routes/admin/aceTemplatesVaMissionsImport')({
    db,
    uploadDir,
    upload,
    authMiddleware,
    adminOnly,
    aceCanManageTemplates,
    ACE_TEMPLATE_TYPES,
    ACE_TEMPLATE_BY_TYPE,
    pathIsStrictlyInsideResolvedRoot,
    resolveMissionStatusInput,
  }));

  // Đợt 6.3c: quản trị cấu hình module trên Trang chủ
  app.use('/api', require('../routes/admin/homepageModules')({
    db,
    authMiddleware,
    adminOnly,
    HOMEPAGE_MODULES_DEFAULT,
  }));

  // Public: cấu hình module cho trang chủ (không cần đăng nhập)
  require('../routes/core/homepageModulesVaLabel')({ HOMEPAGE_MODULES_DEFAULT, app });

  // Đợt 6.3d: quản trị nhãn tiêu chuẩn & danh sách người nhận thông báo chung
  app.use('/api', require('../routes/admin/caiDatVaThongBao')({
    db,
    authMiddleware,
    adminOnly,
    isSafeEmailFormat,
  }));
};
