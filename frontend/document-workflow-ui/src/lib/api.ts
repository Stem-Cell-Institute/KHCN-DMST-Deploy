import axios from "axios";
import { getToken } from "./auth";
import type {
  AdminStats,
  AuditLogItem,
  DocumentDetail,
  DocumentRecord,
  MeUser,
  Unit,
} from "./types";

function baseURL() {
  const envBase = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_API_BASE;
  return envBase || "";
}

export const api = axios.create({
  baseURL: baseURL(),
  timeout: 15000,
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export async function fetchMe() {
  const res = await api.get<MeUser>("/api/me");
  return res.data;
}

export interface ListFilters {
  search?: string;
  step?: string;
  status?: string;
  unitId?: string;
  page?: number;
}

export async function fetchDocuments(filters: ListFilters) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v != null && String(v).trim() !== "") params.set(k, String(v));
  });
  const res = await api.get<{ data: DocumentRecord[]; pagination?: unknown }>(
    `/api/documents?${params.toString()}`
  );
  return res.data;
}

export async function fetchDocumentDetail(id: string) {
  const res = await api.get<{ data: DocumentDetail }>(`/api/documents/${id}`);
  return res.data.data;
}

export async function updateDocument(id: string | number, payload: Record<string, unknown>) {
  const res = await api.put(`/api/documents/${id}`, payload);
  return res.data;
}

export async function deleteDocument(id: string | number) {
  const res = await api.delete(`/api/documents/${id}`);
  return res.data;
}

export async function fetchUnits() {
  const res = await api.get<{ data: Unit[] }>("/api/units");
  return res.data.data;
}

export async function fetchAdminMe() {
  const res = await api.get<{
    ok: boolean;
    data: { user: MeUser; roles: string[]; isMasterAdmin: boolean; isModuleManager: boolean };
  }>("/api/admin/module/me");
  return res.data.data;
}

export async function fetchAdminDashboard() {
  const res = await api.get<{ ok: boolean; data: { stats: AdminStats; recentAudit: AuditLogItem[] } }>(
    "/api/admin/dashboard"
  );
  return res.data.data;
}

export async function fetchAdminUsers() {
  const res = await api.get<{ ok: boolean; data: Array<Record<string, unknown>> }>("/api/admin/users");
  return res.data.data;
}

export async function saveAdminUser(payload: Record<string, unknown>) {
  if (payload.id) {
    const res = await api.put(`/api/admin/users/${payload.id}`, payload);
    return res.data;
  }
  const res = await api.post("/api/admin/users", payload);
  return res.data;
}

export async function setAdminUserActive(userId: number, active: boolean) {
  const res = await api.patch(`/api/admin/users/${userId}/active`, { active });
  return res.data;
}

export async function resetAdminUserPassword(userId: number) {
  const res = await api.post(`/api/admin/users/${userId}/reset-password`);
  return res.data;
}

export async function deleteAdminUser(userId: number) {
  const res = await api.delete(`/api/admin/users/${userId}`);
  return res.data;
}

export async function fetchModulePermissions() {
  const res = await api.get<{ ok: boolean; data: Array<Record<string, unknown>> }>("/api/admin/module-permissions");
  return res.data.data;
}

export async function updateModuleUserRoles(userId: number, roles: string[]) {
  const res = await api.put(`/api/admin/module-permissions/${userId}/roles`, { roles });
  return res.data;
}

export async function fetchAdminUnits() {
  const res = await api.get<{ ok: boolean; data: Unit[] }>("/api/admin/units");
  return res.data.data;
}

export async function createAdminUnit(payload: { code?: string; name: string }) {
  const res = await api.post("/api/admin/units", payload);
  return res.data;
}

export async function updateAdminUnit(unitId: number, payload: { code?: string; name: string; active?: boolean }) {
  const res = await api.put(`/api/admin/units/${unitId}`, payload);
  return res.data;
}

export async function deleteAdminUnit(unitId: number) {
  const res = await api.delete(`/api/admin/units/${unitId}`);
  return res.data;
}

export async function fetchModuleSettings() {
  const res = await api.get("/api/admin/module-settings");
  return res.data.data as {
    settings: Record<string, string>;
    documentTypes: Array<Record<string, unknown>>;
  };
}

export async function saveModuleSettings(payload: Record<string, unknown>) {
  const res = await api.put("/api/admin/module-settings", payload);
  return res.data;
}

export async function saveDocumentType(payload: Record<string, unknown>) {
  if (payload.id) {
    const res = await api.put(`/api/admin/document-types/${payload.id}`, payload);
    return res.data;
  }
  const res = await api.post("/api/admin/document-types", payload);
  return res.data;
}

export async function fetchAuditLogs(filters?: Record<string, string>) {
  const params = new URLSearchParams();
  Object.entries(filters || {}).forEach(([k, v]) => {
    if (v) params.set(k, v);
  });
  const res = await api.get<{ ok: boolean; data: AuditLogItem[] }>(`/api/admin/audit-logs?${params.toString()}`);
  return res.data.data;
}
