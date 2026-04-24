import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  deleteDocument,
  fetchDocumentDetail,
  fetchMe,
  fetchUnits,
  updateDocument,
} from "@/features/document-workflow/use-cases/documentWorkflowApi";
import { parseRoles } from "@/lib/auth";
import type { DocumentDetail, MeUser, Unit } from "@/lib/types";
import { ActivityTimeline } from "@/components/ActivityTimeline";
import { DocumentStepper } from "@/components/DocumentStepper";
import { Badge, Button, Card, Input, Page, Select, Textarea } from "@/components/ui";
import { ConfirmDialog, FormDialog, useToast } from "@/components/admin/AdminPrimitives";
import { WorkflowTopNav } from "@/components/WorkflowTopNav";
import { AttachmentUploader } from "@/features/document-workflow/components/AttachmentUploader";
import { StepForms } from "@/features/document-workflow/components/StepForms";

export function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const nav = useNavigate();
  const [me, setMe] = useState<MeUser | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();
  const roles = parseRoles(me?.role || []);
  const canManageDocs =
    roles.includes("module_manager") ||
    roles.includes("master_admin") ||
    roles.includes("admin");
  const isReadOnlyView = searchParams.get("mode") === "view";

  async function reload() {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const [meData, unitData, detail] = await Promise.all([
        fetchMe(),
        fetchUnits(),
        fetchDocumentDetail(id),
      ]);
      setMe(meData);
      setUnits(unitData);
      setDoc(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được hồ sơ.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!id) {
    return (
      <Page>
        <Card className="mx-auto max-w-3xl p-4">
          <p className="text-sm text-rose-700">Thiếu documentId trong URL.</p>
        </Card>
      </Page>
    );
  }

  return (
    <Page>
      <div className="mx-auto max-w-7xl space-y-4">
        <WorkflowTopNav />
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => nav(-1)}
              className="text-sm font-medium text-primary-700 hover:underline"
            >
              ← Quay lại danh sách
            </button>
            <Link to="/documents" className="text-sm text-slate-500 hover:underline">
              Tới Dashboard
            </Link>
          </div>
          {loading ? <p className="text-sm text-slate-500">Đang tải hồ sơ...</p> : null}
          {error ? <p className="text-sm text-rose-700">{error}</p> : null}
          {doc ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold text-slate-800">{doc.title}</h1>
                <Badge>{doc.doc_type}</Badge>
                <Badge tone={doc.status === "archived" ? "success" : "default"}>
                  {doc.status}
                </Badge>
                {isReadOnlyView ? <Badge tone="warning">Chỉ xem</Badge> : null}
                {canManageDocs && !isReadOnlyView ? (
                  <div className="ml-auto flex gap-2">
                    <Button variant="outline" onClick={() => setEditing(true)}>
                      Chỉnh sửa
                    </Button>
                    <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                      Xóa hồ sơ
                    </Button>
                  </div>
                ) : null}
              </div>
              <div className="grid gap-3 text-sm text-slate-600 md:grid-cols-4">
                <p>
                  <b>Người đề xuất:</b> {doc.proposer_id || "—"}
                </p>
                <p>
                  <b>Đơn vị chủ trì:</b> {doc.assigned_unit_id || "—"}
                </p>
                <p>
                  <b>Người soạn thảo:</b> {doc.assigned_to_id || "—"}
                </p>
                <p>
                  <b>Deadline:</b> {(doc.assignment_deadline || "").slice(0, 10) || "—"}
                </p>
              </div>
              <div className="mt-4">
                <DocumentStepper currentStep={doc.current_step} />
              </div>
            </>
          ) : null}
        </Card>

        {doc ? (
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <div className="space-y-4">
              <StepForms
                me={me}
                document={doc}
                units={units}
                onUpdated={reload}
                forceReadOnly={isReadOnlyView}
              />
              {!isReadOnlyView ? (
                <Card className="p-4">
                  <h3 className="mb-3 text-sm font-semibold text-slate-700">
                    Upload file đính kèm bổ sung
                  </h3>
                  <AttachmentUploader
                    documentId={doc.id}
                    defaultStep={doc.current_step}
                    onDone={reload}
                  />
                </Card>
              ) : null}
            </div>
            <div className="space-y-4">
              <Card className="p-4">
                <h3 className="mb-3 text-sm font-semibold text-slate-700">
                  File đính kèm theo bước
                </h3>
                {doc.attachments.length ? (
                  <div className="space-y-2">
                    {doc.attachments.map((a) => (
                      <a
                        key={a.id}
                        href={`${import.meta.env.VITE_API_BASE || ""}/api/attachments/${a.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="block rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:border-primary-300"
                      >
                        {`B${a.step} - ${a.original_name}`}
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">Chưa có file.</p>
                )}
              </Card>
              <Card className="p-4">
                <h3 className="mb-3 text-sm font-semibold text-slate-700">Lịch sử hoạt động</h3>
                <ActivityTimeline items={doc.history} />
              </Card>
            </div>
          </div>
        ) : null}
      </div>
      <FormDialog
        open={editing && !isReadOnlyView}
        title="Chỉnh sửa thông tin hồ sơ"
        description="Workflow Manager/Master Admin có thể cập nhật trực tiếp hồ sơ."
        onClose={() => setEditing(false)}
      >
        {doc ? (
          <form
            className="grid gap-3 md:grid-cols-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = e.currentTarget;
              await updateDocument(doc.id, {
                title: (f.elements.namedItem("title") as HTMLInputElement).value,
                doc_type: (f.elements.namedItem("doc_type") as HTMLSelectElement).value,
                reason: (f.elements.namedItem("reason") as HTMLTextAreaElement).value,
                proposalSummary: (f.elements.namedItem("proposalSummary") as HTMLTextAreaElement)
                  .value,
                legalBasis: (f.elements.namedItem("legalBasis") as HTMLTextAreaElement).value,
                scope: (f.elements.namedItem("scope") as HTMLTextAreaElement).value,
                applicableSubjects: (
                  f.elements.namedItem("applicableSubjects") as HTMLTextAreaElement
                ).value,
                mainContent: (f.elements.namedItem("mainContent") as HTMLTextAreaElement).value,
                executionClause: (
                  f.elements.namedItem("executionClause") as HTMLTextAreaElement
                ).value,
              });
              toast.push("success", "Đã cập nhật hồ sơ.");
              setEditing(false);
              await reload();
            }}
          >
            <label className="text-sm">
              Tiêu đề
              <Input name="title" defaultValue={doc.title} required />
            </label>
            <label className="text-sm">
              Loại văn bản
              <Select name="doc_type" defaultValue={doc.doc_type}>
                <option value="quy_che">quy_che</option>
                <option value="quy_dinh">quy_dinh</option>
                <option value="noi_quy">noi_quy</option>
                <option value="huong_dan">huong_dan</option>
              </Select>
            </label>
            <label className="text-sm md:col-span-2">
              Lý do
              <Textarea name="reason" rows={2} defaultValue={doc.reason || ""} />
            </label>
            <label className="text-sm md:col-span-2">
              Nội dung đề xuất
              <Textarea
                name="proposalSummary"
                rows={2}
                defaultValue={doc.proposal_summary || ""}
              />
            </label>
            <label className="text-sm">
              Căn cứ pháp lý
              <Textarea name="legalBasis" rows={2} defaultValue={doc.legal_basis || ""} />
            </label>
            <label className="text-sm">
              Phạm vi
              <Textarea name="scope" rows={2} defaultValue={doc.scope || ""} />
            </label>
            <label className="text-sm">
              Đối tượng áp dụng
              <Textarea
                name="applicableSubjects"
                rows={2}
                defaultValue={doc.applicable_subjects || ""}
              />
            </label>
            <label className="text-sm">
              Điều khoản thi hành
              <Textarea
                name="executionClause"
                rows={2}
                defaultValue={doc.execution_clause || ""}
              />
            </label>
            <label className="text-sm md:col-span-2">
              Nội dung chính
              <Textarea name="mainContent" rows={3} defaultValue={doc.main_content || ""} />
            </label>
            <div className="md:col-span-2 flex gap-2">
              <Button type="submit">Lưu</Button>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                Hủy
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
      <ConfirmDialog
        open={confirmDelete && !isReadOnlyView}
        title="Xác nhận xóa hồ sơ"
        description="Hồ sơ sẽ được xóa mềm (đánh dấu deleted_at) và không còn xuất hiện trong danh sách."
        confirmLabel="Xóa hồ sơ"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          if (!doc) return;
          await deleteDocument(doc.id);
          toast.push("success", "Đã xóa hồ sơ.");
          nav("/documents");
        }}
      />
    </Page>
  );
}
