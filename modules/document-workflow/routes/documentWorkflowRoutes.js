const express = require('express');
const DocumentModel = require('../models/DocumentModel');
const { createDocumentPermissionMiddleware } = require('../middleware/documentPermissionMiddleware');
const { createDocumentWorkflowController } = require('../controllers/documentWorkflowController');
const { createDocumentWorkflowAdminController } = require('../controllers/documentWorkflowAdminController');
const { createDocumentUpload } = require('../services/documentUploadService');
const { DocumentRepository } = require('../infrastructure/repositories/DocumentRepository');
const { UnitRepository } = require('../infrastructure/repositories/UnitRepository');
const { UserAdminRepository } = require('../infrastructure/repositories/UserAdminRepository');
const { SettingsRepository } = require('../infrastructure/repositories/SettingsRepository');
const { AuditLogRepository } = require('../infrastructure/repositories/AuditLogRepository');
const { DocumentWorkflowService } = require('../application/document/DocumentWorkflowService');
const { DomainEventBus } = require('../application/events/DomainEventBus');
const { createWorkflowNotificationHandler } = require('../application/notifications/WorkflowNotificationHandler');

function createDocumentWorkflowRoutes(deps) {
  const { db, authMiddleware, uploadsRoot, mailSend, baseUrl } = deps;
  const router = express.Router();
  const model = new DocumentModel(db);
  model.ensureSchema();
  const documentRepository = new DocumentRepository({ db, documentModel: model });
  const unitRepository = new UnitRepository({ db, documentModel: model });
  const userRepository = new UserAdminRepository({ db, documentModel: model });
  const settingsRepository = new SettingsRepository({ db, documentModel: model });
  const auditLogRepository = new AuditLogRepository({ documentModel: model });
  const eventBus = new DomainEventBus();

  const permission = createDocumentPermissionMiddleware(db);
  const workflowService = new DocumentWorkflowService({
    documentRepository,
    unitRepository,
    userRepository,
    settingsRepository,
    eventBus,
    hasAnyRole: permission.hasAnyRole,
    canAccessDocument: permission.canAccessDocument,
  });
  createWorkflowNotificationHandler({
    settingsRepository,
    userRepository,
    mailSend,
    baseUrl,
  }).register(eventBus);
  const controller = createDocumentWorkflowController({
    db,
    documentModel: model,
    documentRepository,
    unitRepository,
    userRepository,
    uploadsRoot,
    hasAnyRole: permission.hasAnyRole,
    canAccessDocument: permission.canAccessDocument,
    mailSend,
    baseUrl,
    workflowService,
  });
  const adminController = createDocumentWorkflowAdminController({
    documentModel: model,
    documentRepository,
    unitRepository,
    userRepository,
    settingsRepository,
    auditLogRepository,
    permission,
  });

  const upload = createDocumentUpload(uploadsRoot);
  const jsonBody = express.json({ limit: '5mb' });

  router.use(authMiddleware);

  router.get('/units', controller.getUnits);
  router.get('/users/assignable', permission.requireRoles(['leader']), controller.getAssignableUsers);
  router.post('/units', permission.requireModuleAdmin, jsonBody, adminController.createUnit);
  router.put('/units/:unitId', permission.requireModuleAdmin, jsonBody, adminController.updateUnit);
  router.delete('/units/:unitId', permission.requireModuleAdmin, adminController.deleteUnit);
  router.get('/dashboard/stats', controller.getDashboardStats);

  router.post('/documents', permission.requireRoles(['proposer', 'drafter']), jsonBody, controller.createDocument);
  router.get('/documents', controller.getDocuments);
  router.get('/documents/:id', controller.getDocumentDetail);
  router.put('/documents/:id', jsonBody, controller.updateDocumentGeneral);
  router.delete('/documents/:id', controller.deleteDocument);
  router.put('/documents/:id/abort', permission.requireModuleAdmin, jsonBody, controller.abortDocument);
  router.put('/documents/:id/assign', permission.requireRoles(['leader']), jsonBody, controller.assignDocument);
  router.post('/documents/:id/draft', permission.requireRoles(['drafter']), upload.array('files', 10), controller.saveDraft);
  router.post('/documents/:id/review', permission.requireRoles(['reviewer']), jsonBody, controller.reviewDocument);
  router.post(
    '/documents/:id/feedback',
    permission.requireRoles(['drafter', 'reviewer', 'leader']),
    jsonBody,
    controller.addFeedback
  );
  router.post('/documents/:id/finalize', permission.requireRoles(['drafter']), upload.array('files', 10), controller.finalizeDraft);
  router.post('/documents/:id/submit', permission.requireRoles(['drafter']), upload.array('files', 10), controller.submitDocument);
  router.put('/documents/:id/publish', permission.requireRoles(['admin']), upload.array('files', 10), controller.publishDocument);
  router.put('/documents/:id/archive', permission.requireRoles(['admin']), jsonBody, controller.archiveDocument);
  router.post('/documents/:id/attachments', upload.array('files', 10), controller.uploadAttachments);
  router.get('/attachments/:id', controller.downloadAttachment);

  // Admin Panel APIs — prefix docflow-admin để tránh trùng GET/POST /api/admin/users (handler trong server.js).
  router.get('/docflow-admin/module/me', adminController.getAdminMe);
  router.get('/docflow-admin/dashboard', permission.requireMasterAdmin, adminController.getDashboard);

  router.get('/docflow-admin/users', permission.requireMasterAdmin, adminController.listUsers);
  router.post('/docflow-admin/users', permission.requireMasterAdmin, jsonBody, adminController.upsertUser);
  router.put('/docflow-admin/users/:userId', permission.requireMasterAdmin, jsonBody, adminController.upsertUser);
  router.patch('/docflow-admin/users/:userId/active', permission.requireMasterAdmin, jsonBody, adminController.toggleUserActive);
  router.delete('/docflow-admin/users/:userId', permission.requireMasterAdmin, adminController.deleteUser);
  router.post('/docflow-admin/users/:userId/reset-password', permission.requireMasterAdmin, adminController.resetUserPassword);

  router.get('/docflow-admin/module-permissions', permission.requireMasterAdmin, adminController.listModulePermissions);
  router.put('/docflow-admin/module-permissions/:userId/roles', permission.requireMasterAdmin, jsonBody, adminController.updateUserRoles);

  router.get('/docflow-admin/units', permission.requireModuleAdmin, adminController.listUnits);
  router.post('/docflow-admin/units', permission.requireModuleAdmin, jsonBody, adminController.createUnit);
  router.put('/docflow-admin/units/:unitId', permission.requireModuleAdmin, jsonBody, adminController.updateUnit);
  router.delete('/docflow-admin/units/:unitId', permission.requireModuleAdmin, adminController.deleteUnit);

  router.get('/docflow-admin/module-settings', permission.requireModuleAdmin, adminController.getModuleSettings);
  router.put('/docflow-admin/module-settings', permission.requireModuleAdmin, jsonBody, adminController.updateModuleSettings);
  router.post('/docflow-admin/document-types', permission.requireModuleAdmin, jsonBody, adminController.upsertDocumentType);
  router.put('/docflow-admin/document-types/:id', permission.requireModuleAdmin, jsonBody, adminController.upsertDocumentType);

  router.get('/docflow-admin/audit-logs', permission.requireMasterAdmin, adminController.listAuditLogs);

  router.get('/docflow-admin/email-notifications', permission.requireMasterAdmin, adminController.getEmailNotificationSettings);
  router.put('/docflow-admin/email-notifications', permission.requireMasterAdmin, jsonBody, adminController.updateEmailNotificationSettings);

  return router;
}

module.exports = createDocumentWorkflowRoutes;
