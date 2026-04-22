import { api } from "@/shared/lib/http";
import type {
  DocumentDetail,
  DocumentRecord,
  MeUser,
  Unit,
} from "@/lib/types";

/**
 * Workflow (9 buoc) API use-cases - goi tu pages cua feature document-workflow.
 */

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
