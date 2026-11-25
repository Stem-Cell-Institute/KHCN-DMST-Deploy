/**
 * Seed admin/meeting, gắn các router CRD, module con (equipment, ngân hàng tế bào, văn bản nội bộ, DMS, analytics) và route dev/users.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../lib/db-bridge');

module.exports = function mountCrdAndSubModules({
  ADMIN_EMAIL,
  CRD_BROADCAST_RATE_BURST,
  CRD_BROADCAST_RATE_MS,
  CRD_BROADCAST_TO_ID,
  JWT_SECRET,
  adminOnly,
  adminOrMasterAdminApi,
  app,
  authMiddleware,
  authUnlessDashboardPermCheck,
  crdBookingToClient,
  crdBroadcastRateMap,
  crdChatToClient,
  crdIsHalfHourMark,
  crdMachineToClient,
  crdPersonBlockedForUse,
  crdPersonHasModeratorSlot,
  crdPersonToUser,
  crdRoleDefsToClient,
  crdRoleSlugValid,
  crdSendBroadcastEmailNotification,
  getSmtpFrom,
  getTokenFromReq,
  insertGd5History,
  insertUserActivityLog,
  masterAdminOnly,
  optionalAuthMiddleware,
  reqIsMasterAdmin,
  transporter,
  userEmailIsMasterAdmin,
  userIdIsBanned,
  rootDir,
}) {
  require('../db/seedAdminVaMeeting')({ ADMIN_EMAIL, insertGd5History });

  // CRD Lab Booking: nếu chưa có thư mục crd-lab-booking với index.html thì trả trang placeholder (tránh "Cannot GET")
  require('../routes/core/crdVaMe')({ app, authMiddleware, userEmailIsMasterAdmin, rootDir: rootDir });

  // ─── API đặt lịch thiết bị CRD (SQLite: crd_*) ─────────────────────────────
  const {
    crdAnnouncementToClient,
    crdBookingOverlaps,
    crdEnsurePersonForAppUser,
    crdGetStateForUser,
    crdLabAnnouncementsActive,
    crdLabAnnouncementsAll,
  } = require('../services/crdStateHelpers')({
    CRD_BROADCAST_TO_ID,
    crdBookingToClient,
    crdChatToClient,
    crdMachineToClient,
    crdPersonToUser,
    crdRoleDefsToClient,
  });

  // Đặt lịch CRD — phần người dùng thường (9 endpoint) đã tách sang routes/crd/nguoiDung.js.
  // Mount ĐÚNG TẠI VỊ TRÍ CŨ.
  app.use('/api', require('../routes/crd/nguoiDung')({
    authMiddleware,
    crdEnsurePersonForAppUser,
    crdPersonBlockedForUse,
    crdGetStateForUser,
    crdIsHalfHourMark,
    db,
    crdBookingOverlaps,
    crypto,
    crdBookingToClient,
    CRD_BROADCAST_TO_ID,
    crdBroadcastRateMap,
    CRD_BROADCAST_RATE_MS,
    CRD_BROADCAST_RATE_BURST,
    crdSendBroadcastEmailNotification,
    crdChatToClient,
  }));

  // Đặt lịch CRD — quản trị snapshot, thông báo phòng lab, thiết bị (9 endpoint) đã tách sang
  // routes/crd/quanTriThietBi.js. Mount ĐÚNG TẠI VỊ TRÍ CŨ: vẫn trước nhóm quản trị hồ sơ CRD bên dưới.
  app.use('/api', require('../routes/crd/quanTriThietBi')({
    authMiddleware,
    adminOnly,
    crdGetStateForUser,
    db,
    crdLabAnnouncementsAll,
    crypto,
    crdAnnouncementToClient,
    crdLabAnnouncementsActive,
    crdMachineToClient,
  }));

  // Đặt lịch CRD — quản trị hồ sơ CRD, tài khoản, vai trò, lịch (12 endpoint) đã tách sang
  // routes/crd/quanTriNguoiDung.js. Mount ĐÚNG TẠI VỊ TRÍ CŨ.
  app.use('/api', require('../routes/crd/quanTriNguoiDung')({
    authMiddleware,
    adminOnly,
    crypto,
    crdRoleSlugValid,
    db,
    crdPersonToUser,
    bcrypt,
    crdRoleDefsToClient,
    crdIsHalfHourMark,
    crdBookingOverlaps,
    crdBookingToClient,
  }));

  /** Phân tích sử dụng thiết bị CRD — routes/equipmentAnalytics.js (entry: server.js, không dùng app.js) */
  require('./modulesConVaAnalytics')({
    JWT_SECRET,
    adminOnly,
    app,
    authMiddleware,
    authUnlessDashboardPermCheck,
    getSmtpFrom,
    getTokenFromReq,
    insertUserActivityLog,
    masterAdminOnly,
    optionalAuthMiddleware,
    reqIsMasterAdmin,
    transporter,
    userEmailIsMasterAdmin,
    userIdIsBanned,
    rootDir: rootDir,
  });

  /** Dev (Master Admin): cấu hình chính sách truy cập dashboard phân tích công bố */
  require('../routes/core/devVaUsers')({ adminOrMasterAdminApi, app, authMiddleware });

  // Đặt lịch CRD — kiểm duyệt tin, email-notif, khiếu nại admin (5 endpoint) đã tách sang
  // routes/crd/kiemDuyetThongBao.js. Mount ĐÚNG TẠI VỊ TRÍ CŨ.
  app.use('/api', require('../routes/crd/kiemDuyetThongBao')({
    authMiddleware,
    db,
    crdEnsurePersonForAppUser,
    CRD_BROADCAST_TO_ID,
    crdPersonHasModeratorSlot,
    adminOnly,
  }));
};
