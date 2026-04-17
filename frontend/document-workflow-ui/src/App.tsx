import { Navigate, Route, Routes } from "react-router-dom";
import { DocumentDetailPage } from "@/pages/DocumentDetailPage";
import { DocumentListPage } from "@/pages/DocumentListPage";
import { AdminLayout } from "@/pages/admin/AdminLayout";
import { AdminDashboardPage } from "@/pages/admin/AdminDashboardPage";
import { UserManagementPage } from "@/pages/admin/UserManagementPage";
import { ModulePermissionsPage } from "@/pages/admin/ModulePermissionsPage";
import { UnitsManagementPage } from "@/pages/admin/UnitsManagementPage";
import { ModuleSettingsPage } from "@/pages/admin/ModuleSettingsPage";
import { AuditLogsPage } from "@/pages/admin/AuditLogsPage";
import { AdminGuard } from "@/components/admin/AdminGuard";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/documents" replace />} />
      <Route path="/documents" element={<DocumentListPage />} />
      <Route path="/documents/:id" element={<DocumentDetailPage />} />
      <Route path="/admin" element={<AdminGuard><AdminLayout /></AdminGuard>}>
        <Route index element={<Navigate to="/admin/module-settings" replace />} />
        <Route path="dashboard" element={<AdminDashboardPage />} />
        <Route path="users" element={<UserManagementPage />} />
        <Route path="module-permissions" element={<ModulePermissionsPage />} />
        <Route path="units" element={<UnitsManagementPage />} />
        <Route path="module-settings" element={<ModuleSettingsPage />} />
        <Route path="audit-logs" element={<AuditLogsPage />} />
      </Route>
    </Routes>
  );
}
