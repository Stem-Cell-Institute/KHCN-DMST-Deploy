import type { AdminStats, AuditLogItem, MeUser, Unit } from "@/lib/types";
import { api } from "./documentWorkflowApi";

export async function fetchAdminMe() {
  const res = await api.get<{
    ok: boolean;
    data: {
      user: MeUser;
      roles: string[];
      isMasterAdmin: boolean;
      isModuleManager: boolean;
    };
  }>("/api/docflow-admin/module/me");
  return res.data.data;
}

export async function fetchAdminDashboard() {
  const res = await api.get<{
    ok: boolean;
    data: { stats: AdminStats; recentAudit: AuditLogItem[] };
  }>("/api/docflow-admin/dashboard");
  return res.data.data;
}

export async function fetchAdminUsers() {
  const res = await api.get<{ ok: boolean; data: Array<Record<string, unknown>> }>(
    "/api/docflow-admin/users"
  );
  return res.data.data;
}

export async function saveAdminUser(payload: Record<string, unknown>) {
  if (payload.id) {
    const res = await api.put(`/api/docflow-admin/users/${payload.id}`, payload);
    return res.data;
  }
  const res = await api.post("/api/docflow-admin/users", payload);
  return res.data;
}

export async function setAdminUserActive(userId: number, active: boolean) {
  const res = await api.patch(`/api/docflow-admin/users/${userId}/active`, { active });
  return res.data;
}

export async function resetAdminUserPassword(userId: number) {
  const res = await api.post(`/api/docflow-admin/users/${userId}/reset-password`);
  return res.data;
}

export async function deleteAdminUser(userId: number) {
  const res = await api.delete(`/api/docflow-admin/users/${userId}`);
  return res.data;
}

export async function fetchModulePermissions() {
  const res = await api.get<{ ok: boolean; data: Array<Record<string, unknown>> }>(
    "/api/docflow-admin/module-permissions"
  );
  return res.data.data;
}

export async function updateModuleUserRoles(userId: number, roles: string[]) {
  const res = await api.put(`/api/docflow-admin/module-permissions/${userId}/roles`, {
    roles,
  });
  return res.data;
}

export async function fetchAdminUnits() {
  const res = await api.get<{ ok: boolean; data: Unit[] }>("/api/docflow-admin/units");
  return res.data.data;
}

export async function createAdminUnit(payload: { code?: string; name: string }) {
  const res = await api.post("/api/docflow-admin/units", payload);
  return res.data;
}

export async function updateAdminUnit(
  unitId: number,
  payload: { code?: string; name: string; active?: boolean }
) {
  const res = await api.put(`/api/docflow-admin/units/${unitId}`, payload);
  return res.data;
}

export async function deleteAdminUnit(unitId: number) {
  const res = await api.delete(`/api/docflow-admin/units/${unitId}`);
  return res.data;
}

export async function fetchModuleSettings() {
  const res = await api.get("/api/docflow-admin/module-settings");
  return res.data.data as {
    settings: Record<string, string>;
    documentTypes: Array<Record<string, unknown>>;
  };
}

export async function saveModuleSettings(payload: Record<string, unknown>) {
  const res = await api.put("/api/docflow-admin/module-settings", payload);
  return res.data;
}

export async function saveDocumentType(payload: Record<string, unknown>) {
  if (payload.id) {
    const res = await api.put(`/api/docflow-admin/document-types/${payload.id}`, payload);
    return res.data;
  }
  const res = await api.post("/api/docflow-admin/document-types", payload);
  return res.data;
}

export async function fetchEmailNotificationSettings() {
  const res = await api.get<{
    ok: boolean;
    data: {
      toggles: Record<string, Record<string, boolean>>;
      catalog: Array<{ key: string; title: string; when: string; recipientsNote: string }>;
      email_enabled: boolean;
    };
  }>("/api/docflow-admin/email-notifications");
  return res.data.data;
}

export async function saveEmailNotificationSettings(payload: {
  toggles: Record<string, Record<string, boolean>>;
  email_enabled?: boolean;
}) {
  const res = await api.put("/api/docflow-admin/email-notifications", payload);
  return res.data.data as {
    toggles: Record<string, Record<string, boolean>>;
    catalog: Array<{ key: string; title: string; when: string; recipientsNote: string }>;
    email_enabled: boolean;
  };
}

export async function fetchAuditLogs(filters?: Record<string, string>) {
  const params = new URLSearchParams();
  Object.entries(filters || {}).forEach(([k, v]) => {
    if (v) params.set(k, v);
  });
  const res = await api.get<{ ok: boolean; data: AuditLogItem[] }>(
    `/api/docflow-admin/audit-logs?${params.toString()}`
  );
  return res.data.data;
}
