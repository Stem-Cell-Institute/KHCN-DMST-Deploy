/**
 * Gắn ticker, RSS sidebar, đăng ký/đăng nhập/quên mật khẩu và 3 router Nộp hồ sơ SCI-ACE (/api/submissions*).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../lib/db-bridge');

module.exports = function mountAuthAndSubmissions({
  ALLOWED_EMAIL_DOMAIN,
  CRD_ONLY_USER_ROLE,
  JWT_SECRET,
  PORT,
  ROLE_LABELS,
  adminOnly,
  app,
  authMiddleware,
  clearAuthCookie,
  fixFilenameEncoding,
  getSmtpFrom,
  getTokenFromReq,
  insertGd5History,
  insertUserActivityLog,
  isSafeEmailFormat,
  prepareDownloadFileList,
  resolveGdSubmissionDirForRmSync,
  roleIsAny,
  safeDownload,
  sanitizeFolderName,
  sendConditionalRejectEmail,
  sendConditionalSubmitEmail,
  sendDecisionIssuedEmail,
  sendMeetingResultEmail,
  sendNotificationToCouncil,
  sendPasswordResetEmail,
  sendResubmitEmail,
  sendStage3ResultEmail,
  sendStage4AssignmentEmail,
  setAuthCookie,
  transporter,
  upload,
  uploadDir,
  userEmailIsMasterAdmin,
  userHasLoginPassword,
  userIdIsBanned,
  usersWithAnyRole,
}) {
  const createTickerRouter = require('../routes/ticker');
  app.use(
    '/',
    createTickerRouter({
      db,
      authMiddleware,
      jwt,
      JWT_SECRET,
      getTokenFromReq,
      userIdIsBanned,
      clearAuthCookie,
    })
  );

  const registerHomepageSidebarRss = require('../routes/homepageSidebarRss');
  registerHomepageSidebarRss(app, { db, authMiddleware, adminOnly });

  // --- API ---

  /** Đã có mật khẩu đăng nhập (đã kích hoạt). Cột password có thể NOT NULL nên dùng '' làm sentinel “chưa kích hoạt”. */

  // Đăng ký (chỉ @sci.edu.vn) có XÁC MINH email: gửi liên kết dùng một lần, mật khẩu đặt SAU khi xác minh. Xem routes/dangKy.js
  app.use(
    '/api/register',
    require('../routes/dangKy')({
      db,
      mailSend: transporter ? (o) => transporter.sendMail({ from: getSmtpFrom(), ...o }) : null,
      baseUrl: process.env.BASE_URL || 'http://localhost:' + PORT,
      bcrypt,
      jwt,
      JWT_SECRET,
      setAuthCookie,
      userEmailIsMasterAdmin,
      isSafeEmailFormat,
      allowedDomain: ALLOWED_EMAIL_DOMAIN, emailDuocPhep: (em) => require('../services/nganHangTeBaoKhangTheSinhVien').emailDuocDangKy(db, em),
    })
  );

  // Đăng nhập
  require('../routes/core/auth')({
    JWT_SECRET,
    app,
    authMiddleware,
    clearAuthCookie,
    getTokenFromReq,
    insertUserActivityLog,
    setAuthCookie,
    userEmailIsMasterAdmin,
    userHasLoginPassword,
  });

  // Đăng ký công khai cho module CRD (1 endpoint) đã tách sang routes/crd/dangKyCongKhai.js.
  // Mount ĐÚNG TẠI VỊ TRÍ CŨ.
  app.use('/api', require('../routes/crd/dangKyCongKhai')({
    ALLOWED_EMAIL_DOMAIN,
    CRD_ONLY_USER_ROLE,
    bcrypt,
    db,
    jwt,
    JWT_SECRET,
    setAuthCookie, emailSinhVienDangCho: (em) => require('../services/nganHangTeBaoKhangTheSinhVien').emailDuocDangKy(db, em),
  }));

  /** email (chuẩn hoá) → thời điểm gửi mail quên mật khẩu gần nhất — chống email bomb SMTP */
  require('../routes/core/passwordReset')({ app, sendPasswordResetEmail });

  // Hồ sơ SCI-ACE — nhóm cơ bản (4 endpoint: nộp, danh sách, danh sách Hội đồng, chi tiết) đã tách sang routes/submissions/hoSoCoBan.js.
  app.use('/api', require('../routes/submissions/hoSoCoBan')({
    db,
    authMiddleware,
    upload,
    uploadDir,
    sanitizeFolderName,
    fixFilenameEncoding,
    sendNotificationToCouncil,
    roleIsAny,
    usersWithAnyRole,
    ROLE_LABELS,
  }));

  // Hồ sơ SCI-ACE — GĐ6 & GĐ7 (7 endpoint: có điều kiện, họp, cấp QĐ, báo cáo) đã tách sang routes/submissions/nghiemThuVaQuyetDinh.js.
  app.use('/api', require('../routes/submissions/nghiemThuVaQuyetDinh')({
    db,
    authMiddleware,
    upload,
    uploadDir,
    fixFilenameEncoding,
    insertGd5History,
    sendConditionalSubmitEmail,
    roleIsAny,
    sendConditionalRejectEmail,
    sendMeetingResultEmail,
    PORT,
    sendDecisionIssuedEmail,
  }));

  // Hồ sơ SCI-ACE — tải file, GĐ3/GĐ4/GĐ5, download & xóa (10 endpoint) đã tách sang routes/submissions/kiemTraPhanBien.js.
  app.use('/api', require('../routes/submissions/kiemTraPhanBien')({
    db,
    authMiddleware,
    adminOnly,
    upload,
    uploadDir,
    roleIsAny,
    usersWithAnyRole,
    safeDownload,
    prepareDownloadFileList,
    resolveGdSubmissionDirForRmSync,
    fixFilenameEncoding,
    insertGd5History,
    sendStage3ResultEmail,
    sendResubmitEmail,
    sendStage4AssignmentEmail,
  }));
};
