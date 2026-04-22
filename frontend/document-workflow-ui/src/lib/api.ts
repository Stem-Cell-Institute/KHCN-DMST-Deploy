/**
 * @deprecated (remove after 2026-07-01): lib/api.ts da duoc tach theo feature.
 *   - Workflow:  `@/features/document-workflow/use-cases/documentWorkflowApi`
 *   - Admin:     `@/features/document-workflow/admin/use-cases/adminWorkflowApi`
 *   - HTTP client chung: `@/shared/lib/http`
 * File nay chi con re-export shim de tranh break import cu.
 */
export { api } from "@/shared/lib/http";

export {
  fetchMe,
  fetchDocuments,
  fetchDocumentDetail,
  updateDocument,
  deleteDocument,
  fetchUnits,
  type ListFilters,
} from "@/features/document-workflow/use-cases/documentWorkflowApi";

export {
  fetchAdminMe,
  fetchAdminDashboard,
  fetchAdminUsers,
  saveAdminUser,
  setAdminUserActive,
  resetAdminUserPassword,
  deleteAdminUser,
  fetchModulePermissions,
  updateModuleUserRoles,
  fetchAdminUnits,
  createAdminUnit,
  updateAdminUnit,
  deleteAdminUnit,
  fetchModuleSettings,
  saveModuleSettings,
  saveDocumentType,
  fetchAuditLogs,
} from "@/features/document-workflow/admin/use-cases/adminWorkflowApi";
