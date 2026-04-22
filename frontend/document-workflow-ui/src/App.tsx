import { Navigate, Route, Routes } from "react-router-dom";
import { DocumentDetailPage } from "@/features/document-workflow/pages/DocumentDetailPage";
import { DocumentListPage } from "@/features/document-workflow/pages/DocumentListPage";
import { AdminLayout } from "@/features/document-workflow/admin/pages/AdminLayout";
import { AdminDashboardPage } from "@/features/document-workflow/admin/pages/AdminDashboardPage";
import { UserManagementPage } from "@/features/document-workflow/admin/pages/UserManagementPage";
import { ModulePermissionsPage } from "@/features/document-workflow/admin/pages/ModulePermissionsPage";
import { UnitsManagementPage } from "@/features/document-workflow/admin/pages/UnitsManagementPage";
import { ModuleSettingsPage } from "@/features/document-workflow/admin/pages/ModuleSettingsPage";
import { AuditLogsPage } from "@/features/document-workflow/admin/pages/AuditLogsPage";
import { AdminGuard } from "@/features/document-workflow/admin/components/AdminGuard";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/documents" replace />} />
      <Route path="/documents" element={<DocumentListPage />} />
      <Route path="/documents/:id" element={<DocumentDetailPage />} />
      <Route path="/admin" element={<AdminGuard><AdminLayout /></AdminGuard>}>
        <Route index element={<Navigate to="/admin/module-settings" replace />} />
        <Route
          path="dashboard"
          element={
            <AdminGuard requiredRoles={["master_admin"]}>
              <AdminDashboardPage />
            </AdminGuard>
          }
        />
        <Route
          path="users"
          element={
            <AdminGuard requiredRoles={["master_admin"]}>
              <UserManagementPage />
            </AdminGuard>
          }
        />
        <Route path="module-permissions" element={<ModulePermissionsPage />} />
        <Route path="units" element={<UnitsManagementPage />} />
        <Route path="module-settings" element={<ModuleSettingsPage />} />
        <Route path="audit-logs" element={<AuditLogsPage />} />
      </Route>
    </Routes>
  );
}
