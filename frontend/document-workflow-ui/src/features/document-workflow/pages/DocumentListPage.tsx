import { useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import {
  deleteDocument,
  fetchDocuments,
  fetchMe,
  fetchUnits,
  updateDocument,
} from "@/features/document-workflow/use-cases/documentWorkflowApi";
import { parseRoles } from "@/lib/auth";
import { canCreateDocument } from "@/lib/permissions";
import { STEP_LABELS } from "@/lib/constants";
import type { DocumentRecord, MeUser, Unit } from "@/lib/types";
import { Badge, Button, Card, Input, Page, Select, Textarea } from "@/components/ui";
import { ConfirmDialog, FormDialog, useToast } from "@/components/admin/AdminPrimitives";
import { WorkflowTopNav } from "@/components/WorkflowTopNav";

function stepBadgeTone(step: number) {
  if (step >= 9) return "success";
  if (step >= 4) return "warning";
  return "default";
}

export function DocumentListPage() {
  const nav = useNavigate();
  const [me, setMe] = useState<MeUser | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [rows, setRows] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [step, setStep] = useState("");
  const [status, setStatus] = useState("");
  const [unitId, setUnitId] = useState("");
  const [editing, setEditing] = useState<DocumentRecord | null>(null);
  const [deleting, setDeleting] = useState<DocumentRecord | null>(null);
  const toast = useToast();

  const filters = useMemo(
    () => ({ search, step, status, unitId, page: 1 }),
    [search, step, status, unitId]
  );
  const roles = useMemo(() => parseRoles(me?.role || []), [me]);
  const canManageDocs =
    roles.includes("module_manager") ||
    roles.includes("master_admin") ||
    roles.includes("admin");

  useEffect(() => {
    void (async () => {
      try {
        const [meData, unitsData] = await Promise.all([fetchMe(), fetchUnits()]);
        setMe(meData);
        setUnits(unitsData);
      } finally {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    setLoading(true);
    void (async () => {
      try {
        const data = await fetchDocuments(filters);
        setRows(data.data || []);
      } finally {
        setLoading(false);
      }
    })();
  }, [filters]);

  return (
    <Page>
      <div className="mx-auto max-w-7xl space-y-4">
        <WorkflowTopNav />
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-slate-800">
                Dashboard hồ sơ văn bản nội bộ
              </h1>
              <p className="text-sm text-slate-500">Theo dõi và điều phối quy trình 9 bước.</p>
            </div>
            {canCreateDocument(me) ? <Button>Tạo hồ sơ mới</Button> : null}
          </div>
        </Card>

        <Card className="p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <Input
              placeholder="Tìm theo tiêu đề..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select value={step} onChange={(e) => setStep(e.target.value)}>
              <option value="">Tất cả bước</option>
              {Object.entries(STEP_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{`Bước ${k} - ${v}`}</option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Tất cả trạng thái</option>
              <option value="pending">pending</option>
              <option value="in_progress">in_progress</option>
              <option value="completed">completed</option>
              <option value="rejected">rejected</option>
              <option value="archived">archived</option>
            </Select>
            <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">Tất cả đơn vị</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">ID</th>
                  <th className="px-3 py-2 text-left">Tiêu đề</th>
                  <th className="px-3 py-2 text-left">Loại</th>
                  <th className="px-3 py-2 text-left">Đơn vị</th>
                  <th className="px-3 py-2 text-left">Bước hiện tại</th>
                  <th className="px-3 py-2 text-left">Trạng thái</th>
                  <th className="px-3 py-2 text-left">Tiến độ</th>
                  <th className="px-3 py-2 text-left">Ngày tạo</th>
                  {canManageDocs ? <th className="px-3 py-2 text-left">Thao tác</th> : null}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td className="px-3 py-4 text-slate-500" colSpan={canManageDocs ? 9 : 8}>
                      Đang tải dữ liệu...
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td className="px-3 py-4 text-slate-500" colSpan={canManageDocs ? 9 : 8}>
                      Không có hồ sơ phù hợp.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr
                      key={r.id}
                      className="cursor-pointer border-t border-slate-100 hover:bg-slate-50/70"
                      onClick={() => nav(`/documents/${r.id}?mode=view`)}
                    >
                      <td className="px-3 py-2">{r.id}</td>
                      <td className="px-3 py-2 font-medium text-primary-700">{r.title}</td>
                      <td className="px-3 py-2">{r.doc_type}</td>
                      <td className="px-3 py-2">{r.assigned_unit_id || "—"}</td>
                      <td className="px-3 py-2">
                        <Badge tone={stepBadgeTone(r.current_step) as never}>
                          {`B${r.current_step}`}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">{r.status}</td>
                      <td className="px-3 py-2">
                        <div className="w-40 rounded-full bg-slate-200">
                          <div
                            className="h-2 rounded-full bg-primary-600"
                            style={{ width: `${(r.current_step / 9) * 100}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2">{(r.created_at || "").slice(0, 10) || "—"}</td>
                      {canManageDocs ? (
                        <td className="px-3 py-2">
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditing(r);
                              }}
                            >
                              Sửa
                            </Button>
                            <Button
                              variant="danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleting(r);
                              }}
                            >
                              Xóa
                            </Button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <FormDialog
        open={!!editing}
        title="Sửa thông tin hồ sơ"
        description="Quyền dành cho Module Manager/Master Admin."
        onClose={() => setEditing(null)}
      >
        {editing ? (
          <form
            className="grid gap-3 md:grid-cols-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = e.currentTarget;
              await updateDocument(editing.id, {
                title: (f.elements.namedItem("title") as HTMLInputElement).value,
                doc_type: (f.elements.namedItem("doc_type") as HTMLInputElement).value,
                reason: (f.elements.namedItem("reason") as HTMLTextAreaElement).value,
              });
              toast.push("success", "Đã cập nhật hồ sơ.");
              setEditing(null);
              const data = await fetchDocuments(filters);
              setRows(data.data || []);
            }}
          >
            <label className="text-sm">
              Tiêu đề
              <Input name="title" defaultValue={editing.title} required />
            </label>
            <label className="text-sm">
              Loại văn bản
              <Input name="doc_type" defaultValue={editing.doc_type} required />
            </label>
            <label className="text-sm md:col-span-2">
              Lý do
              <Textarea name="reason" rows={3} defaultValue={editing.reason || ""} />
            </label>
            <div className="md:col-span-2 flex gap-2">
              <Button type="submit">Lưu</Button>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Hủy
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
      <ConfirmDialog
        open={!!deleting}
        title="Xác nhận xóa hồ sơ"
        description={`Hồ sơ #${deleting?.id || ""} sẽ bị xóa mềm và ẩn khỏi danh sách.`}
        confirmLabel="Xóa hồ sơ"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await deleteDocument(deleting.id);
          toast.push("success", "Đã xóa hồ sơ.");
          setDeleting(null);
          const data = await fetchDocuments(filters);
          setRows(data.data || []);
        }}
      />
    </Page>
  );
}
