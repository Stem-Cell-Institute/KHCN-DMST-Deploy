const express = require('express');
const DocumentModel = require('../models/DocumentModel');
const { createDocumentPermissionMiddleware } = require('../middleware/documentPermissionMiddleware');
const { createDocumentWorkflowController } = require('../controllers/documentWorkflowController');
const { createDocumentWorkflowAdminController } = require('../controllers/documentWorkflowAdminController');
const { createDocumentUpload } = require('../services/documentUploadService');

function createDocumentWorkflowRoutes(deps) {
  const { db, authMiddleware, uploadsRoot, mailSend, baseUrl } = deps;
  const router = express.Router();
  const model = new DocumentModel(db);
  model.ensureSchema();

  const permission = createDocumentPermissionMiddleware(db);
  const controller = createDocumentWorkflowController({
    db,
    documentModel: model,
    uploadsRoot,
    hasAnyRole: permission.hasAnyRole,
    canAccessDocument: permission.canAccessDocument,
    mailSend,
    baseUrl,
  });
  const adminController = createDocumentWorkflowAdminController({
    documentModel: model,
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

  // Admin Panel APIs
  router.get('/admin/module/me', adminController.getAdminMe);
  router.get('/admin/dashboard', permission.requireMasterAdmin, adminController.getDashboard);

  router.get('/admin/users', permission.requireMasterAdmin, adminController.listUsers);
  router.post('/admin/users', permission.requireMasterAdmin, jsonBody, adminController.upsertUser);
  router.put('/admin/users/:userId', permission.requireMasterAdmin, jsonBody, adminController.upsertUser);
  router.patch('/admin/users/:userId/active', permission.requireMasterAdmin, jsonBody, adminController.toggleUserActive);
  router.delete('/admin/users/:userId', permission.requireMasterAdmin, adminController.deleteUser);
  router.post('/admin/users/:userId/reset-password', permission.requireMasterAdmin, adminController.resetUserPassword);

  router.get('/admin/module-permissions', permission.requireMasterAdmin, adminController.listModulePermissions);
  router.put('/admin/module-permissions/:userId/roles', permission.requireMasterAdmin, jsonBody, adminController.updateUserRoles);

  router.get('/admin/units', permission.requireModuleAdmin, adminController.listUnits);
  router.post('/admin/units', permission.requireModuleAdmin, jsonBody, adminController.createUnit);
  router.put('/admin/units/:unitId', permission.requireModuleAdmin, jsonBody, adminController.updateUnit);
  router.delete('/admin/units/:unitId', permission.requireModuleAdmin, adminController.deleteUnit);

  router.get('/admin/module-settings', permission.requireModuleAdmin, adminController.getModuleSettings);
  router.put('/admin/module-settings', permission.requireModuleAdmin, jsonBody, adminController.updateModuleSettings);
  router.post('/admin/document-types', permission.requireModuleAdmin, jsonBody, adminController.upsertDocumentType);
  router.put('/admin/document-types/:id', permission.requireModuleAdmin, jsonBody, adminController.upsertDocumentType);

  router.get('/admin/audit-logs', permission.requireMasterAdmin, adminController.listAuditLogs);

  return router;
}

module.exports = createDocumentWorkflowRoutes;
