import { useMemo, useState, type ReactNode } from "react";
import { api } from "@/features/document-workflow/use-cases/documentWorkflowApi";
import { DOC_TYPE_OPTIONS } from "@/lib/constants";
import { stepPermission } from "@/lib/permissions";
import type { DocumentDetail, MeUser, Unit, WorkflowStep } from "@/lib/types";
import { Badge, Button, Card, Input, Select, Textarea } from "@/components/ui";

interface StepFormsProps {
  me: MeUser | null;
  document: DocumentDetail;
  units: Unit[];
  onUpdated: () => Promise<void> | void;
  forceReadOnly?: boolean;
}

function Block({
  title,
  step,
  enabled,
  reason,
  children,
}: {
  title: string;
  step: WorkflowStep;
  enabled: boolean;
  reason?: string;
  children: ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        <Badge tone={enabled ? "success" : "warning"}>
          {enabled ? "Có quyền thao tác" : "Chỉ xem"}
        </Badge>
      </div>
      {enabled ? null : (
        <p className="mb-3 rounded-md bg-amber-50 p-2 text-xs text-amber-700">
          {reason || `Không thể thao tác bước ${step}`}
        </p>
      )}
      <div className={enabled ? "" : "pointer-events-none opacity-70"}>{children}</div>
    </Card>
  );
}

export function StepForms({
  me,
  document,
  units,
  onUpdated,
  forceReadOnly = false,
}: StepFormsProps) {
  const [loadingKey, setLoadingKey] = useState<string>("");
  const [error, setError] = useState("");
  const [feedbackText, setFeedbackText] = useState("");

  const permissions = useMemo(() => {
    const map = new Map<WorkflowStep, ReturnType<typeof stepPermission>>();
    (Array.from({ length: 9 }, (_, i) => i + 1) as WorkflowStep[]).forEach((step) => {
      map.set(step, stepPermission(me, document, step));
    });
    return map;
  }, [me, document]);

  async function submitJson(
    key: string,
    url: string,
    payload: unknown,
    method: "POST" | "PUT" = "POST"
  ) {
    setError("");
    setLoadingKey(key);
    try {
      await api.request({ method, url, data: payload });
      await onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Thao tác thất bại.");
    } finally {
      setLoadingKey("");
    }
  }

  async function submitFormData(
    key: string,
    url: string,
    form: HTMLFormElement,
    method: "POST" | "PUT" = "POST"
  ) {
    setError("");
    setLoadingKey(key);
    try {
      const fd = new FormData(form);
      await api.request({ method, url, data: fd });
      await onUpdated();
      form.reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Thao tác thất bại.");
    } finally {
      setLoadingKey("");
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      <Block
        title="Bước 1 - Đề xuất"
        step={1}
        enabled={!forceReadOnly && (permissions.get(1)?.canAct ?? false)}
        reason={
          forceReadOnly
            ? "Đang ở chế độ chỉ xem, không thể chỉnh sửa."
            : permissions.get(1)?.reason
        }
      >
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = e.currentTarget;
            const payload = {
              title: (f.elements.namedItem("title") as HTMLInputElement).value,
              doc_type: (f.elements.namedItem("doc_type") as HTMLSelectElement).value,
              reason: (f.elements.namedItem("reason") as HTMLTextAreaElement).value,
              proposalSummary: (f.elements.namedItem("proposalSummary") as HTMLTextAreaElement)
                .value,
            };
            submitJson("step1", "/api/documents", payload, "POST");
          }}
        >
          <label className="text-sm">
            Tiêu đề
            <Input name="title" defaultValue={document.title} required />
          </label>
          <label className="text-sm">
            Loại văn bản
            <Select name="doc_type" defaultValue={document.doc_type}>
              {DOC_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-sm md:col-span-2">
            Lý do ban hành
            <Textarea name="reason" rows={2} defaultValue={document.reason || ""} />
          </label>
          <label className="text-sm md:col-span-2">
            Nội dung đề xuất sơ bộ
            <Textarea
              name="proposalSummary"
              rows={3}
              defaultValue={document.proposal_summary || ""}
            />
          </label>
          <div className="md:col-span-2">
            <Button disabled={loadingKey === "step1"}>
              {loadingKey === "step1" ? "Đang lưu..." : "Lưu/Gửi đề xuất"}
            </Button>
          </div>
        </form>
      </Block>

      <Block
        title="Bước 2 - Phân công soạn thảo"
        step={2}
        enabled={!forceReadOnly && (permissions.get(2)?.canAct ?? false)}
        reason={
          forceReadOnly
            ? "Đang ở chế độ chỉ xem, không thể chỉnh sửa."
            : permissions.get(2)?.reason
        }
      >
        <form
          className="grid gap-3 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = e.currentTarget;
            const unitId = Number((f.elements.namedItem("unitId") as HTMLSelectElement).value);
            const assignedToId = Number(
              (f.elements.namedItem("assignedToId") as HTMLInputElement).value
            );
            const deadline = (f.elements.namedItem("deadline") as HTMLInputElement).value;
            if (!unitId || !assignedToId || !deadline) {
              setError("Bước 2 cần đủ đơn vị, người soạn thảo và deadline.");
              return;
            }
            submitJson(
              "step2",
              `/api/documents/${document.id}/assign`,
              { unitId, assignedToId, deadline },
              "PUT"
            );
          }}
        >
          <label className="text-sm">
            Đơn vị chủ trì
            <Select name="unitId" defaultValue={String(document.assigned_unit_id || "")}>
              <option value="">Chọn đơn vị</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-sm">
            Người soạn thảo (ID)
            <Input
              type="number"
              name="assignedToId"
              defaultValue={document.assigned_to_id || ""}
              min={1}
            />
          </label>
          <label className="text-sm">
            Deadline
            <Input
              type="date"
              name="deadline"
              defaultValue={(document.assignment_deadline || "").slice(0, 10)}
            />
          </label>
          <div className="md:col-span-3">
            <Button disabled={loadingKey === "step2"}>
              {loadingKey === "step2" ? "Đang phân công..." : "Phân công"}
            </Button>
          </div>
        </form>
      </Block>

      <Block
        title="Bước 3 - Soạn thảo dự thảo lần 1"
        step={3}
        enabled={!forceReadOnly && (permissions.get(3)?.canAct ?? false)}
        reason={
          forceReadOnly
            ? "Đang ở chế độ chỉ xem, không thể chỉnh sửa."
            : permissions.get(3)?.reason
        }
      >
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            submitFormData(
              "step3",
              `/api/documents/${document.id}/draft`,
              e.currentTarget,
              "POST"
            );
          }}
        >
          <input type="hidden" name="step" value="3" />
          <label className="text-sm md:col-span-2">
            Căn cứ pháp lý
            <Textarea name="legalBasis" defaultValue={document.legal_basis || ""} rows={2} />
          </label>
          <label className="text-sm">
            Phạm vi điều chỉnh
            <Textarea name="scope" defaultValue={document.scope || ""} rows={2} />
          </label>
          <label className="text-sm">
            Đối tượng áp dụng
            <Textarea
              name="applicableSubjects"
              defaultValue={document.applicable_subjects || ""}
              rows={2}
            />
          </label>
          <label className="text-sm md:col-span-2">
            Nội dung quy định chính
            <Textarea name="mainContent" defaultValue={document.main_content || ""} rows={3} />
          </label>
          <label className="text-sm md:col-span-2">
            Điều khoản thi hành
            <Textarea
              name="executionClause"
              defaultValue={document.execution_clause || ""}
              rows={2}
            />
          </label>
          <label className="text-sm md:col-span-2">
            File dự thảo (PDF/DOCX)
            <Input name="files" type="file" multiple required />
          </label>
          <div className="md:col-span-2">
            <Button disabled={loadingKey === "step3"}>
              {loadingKey === "step3" ? "Đang gửi..." : "Lưu nháp / Gửi thẩm định"}
            </Button>
          </div>
        </form>
      </Block>

      <Block
        title="Bước 4 - Thẩm định"
        step={4}
        enabled={!forceReadOnly && (permissions.get(4)?.canAct ?? false)}
        reason={
          forceReadOnly
            ? "Đang ở chế độ chỉ xem, không thể chỉnh sửa."
            : permissions.get(4)?.reason
        }
      >
        <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <p>
            <b>Căn cứ pháp lý:</b> {document.legal_basis || "—"}
          </p>
          <p>
            <b>Phạm vi:</b> {document.scope || "—"}
          </p>
          <p>
            <b>Đối tượng áp dụng:</b> {document.applicable_subjects || "—"}
          </p>
          <p>
            <b>Nội dung chính:</b> {document.main_content || "—"}
          </p>
        </div>
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = e.currentTarget;
            const action = (f.elements.namedItem("action") as HTMLSelectElement).value;
            const comment = (f.elements.namedItem("comment") as HTMLTextAreaElement).value.trim();
            if (action === "reject" && comment.length < 8) {
              setError("Nếu từ chối, nhận xét cần tối thiểu 8 ký tự.");
              return;
            }
            submitJson(
              "step4",
              `/api/documents/${document.id}/review`,
              { action, comment },
              "POST"
            );
          }}
        >
          <label className="text-sm">
            Kết quả
            <Select name="action" defaultValue="approve">
              <option value="approve">Duyệt</option>
              <option value="reject">Từ chối</option>
            </Select>
          </label>
          <label className="text-sm md:col-span-2">
            Nhận xét
            <Textarea name="comment" rows={3} defaultValue={document.review_comment || ""} />
          </label>
          <div className="md:col-span-2">
            <Button disabled={loadingKey === "step4"}>
              {loadingKey === "step4" ? "Đang gửi..." : "Gửi kết quả thẩm định"}
            </Button>
          </div>
        </form>
      </Block>

      <Block
        title="Bước 5 - Lấy ý kiến góp ý"
        step={5}
        enabled={!forceReadOnly && (permissions.get(5)?.canAct ?? false)}
        reason={
          forceReadOnly
            ? "Đang ở chế độ chỉ xem, không thể chỉnh sửa."
            : permissions.get(5)?.reason
        }
      >
        <div className="mb-3 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
          {document.feedback.length ? (
            document.feedback.map((f) => (
              <div key={f.id} className="rounded border border-slate-200 bg-white p-2 text-sm">
                <p className="text-slate-700">{f.content}</p>
                <p className="mt-1 text-xs text-slate-500">{f.created_at || ""}</p>
              </div>
            ))
          ) : (
            <p className="text-sm text-slate-500">Chưa có góp ý.</p>
          )}
        </div>
        <div className="grid gap-2 md:grid-cols-[1fr_auto]">
          <Textarea
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            rows={3}
            placeholder="Nhập ý kiến góp ý"
          />
          <Button
            disabled={loadingKey === "step5"}
            onClick={() => {
              if (feedbackText.trim().length < 5) {
                setError("Ý kiến góp ý cần tối thiểu 5 ký tự.");
                return;
              }
              submitJson(
                "step5",
                `/api/documents/${document.id}/feedback`,
                { content: feedbackText },
                "POST"
              ).then(() => setFeedbackText(""));
            }}
          >
            {loadingKey === "step5" ? "Đang gửi..." : "Thêm góp ý"}
          </Button>
        </div>
      </Block>

      <Block
        title="Bước 6 - Hoàn thiện dự thảo"
        step={6}
        enabled={!forceReadOnly && (permissions.get(6)?.canAct ?? false)}
        reason={
          forceReadOnly
            ? "Đang ở chế độ chỉ xem, không thể chỉnh sửa."
            : permissions.get(6)?.reason
        }
      >
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submitFormData(
              "step6",
              `/api/documents/${document.id}/finalize`,
              e.currentTarget,
              "POST"
            );
          }}
        >
          <input type="hidden" name="step" value="6" />
          <label className="text-sm">
            Giải trình tiếp thu
            <Textarea
              name="explainReceive"
              defaultValue={document.explain_receive || ""}
              rows={3}
              required
            />
          </label>
          <label className="text-sm">
            Tổng hợp ý kiến
            <Textarea
              name="feedbackSummary"
              defaultValue={document.feedback_summary || ""}
              rows={3}
            />
          </label>
          <label className="text-sm">
            File dự thảo cuối
            <Input name="files" type="file" multiple required />
          </label>
          <Button disabled={loadingKey === "step6"}>
            {loadingKey === "step6" ? "Đang gửi..." : "Hoàn tất dự thảo"}
          </Button>
        </form>
      </Block>

      <Block
        title="Bước 7 - Trình ký ban hành"
        step={7}
        enabled={!forceReadOnly && (permissions.get(7)?.canAct ?? false)}
        reason={
          forceReadOnly
            ? "Đang ở chế độ chỉ xem, không thể chỉnh sửa."
            : permissions.get(7)?.reason
        }
      >
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            submitFormData(
              "step7",
              `/api/documents/${document.id}/submit`,
              e.currentTarget,
              "POST"
            );
          }}
        >
          <input type="hidden" name="step" value="7" />
          <label className="text-sm">
            Tờ trình (bắt buộc)
            <Input name="files" type="file" required />
          </label>
          <label className="text-sm">
            Dự thảo Quyết định (bắt buộc)
            <Input name="files" type="file" required />
          </label>
          <label className="text-sm">
            Dự thảo Quy chế/Quy định (bắt buộc)
            <Input name="files" type="file" required />
          </label>
          <label className="text-sm">
            Bảng tổng hợp giải trình (tùy chọn)
            <Input name="files" type="file" />
          </label>
          <label className="text-sm md:col-span-2">
            Ghi chú trình ký
            <Textarea name="submitNote" defaultValue={document.submit_note || ""} rows={2} />
          </label>
          <div className="md:col-span-2">
            <Button disabled={loadingKey === "step7"}>
              {loadingKey === "step7" ? "Đang trình ký..." : "Trình ký"}
            </Button>
          </div>
        </form>
      </Block>

      <Block
        title="Bước 8 - Ban hành, công bố"
        step={8}
        enabled={!forceReadOnly && (permissions.get(8)?.canAct ?? false)}
        reason={
          forceReadOnly
            ? "Đang ở chế độ chỉ xem, không thể chỉnh sửa."
            : permissions.get(8)?.reason
        }
      >
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            submitFormData(
              "step8",
              `/api/documents/${document.id}/publish`,
              e.currentTarget,
              "PUT"
            );
          }}
        >
          <input type="hidden" name="step" value="8" />
          <label className="text-sm">
            Số hiệu văn bản
            <Input name="documentNumber" defaultValue={document.document_number || ""} required />
          </label>
          <label className="text-sm">
            Ngày ban hành
            <Input
              name="publishDate"
              type="date"
              defaultValue={(document.publish_date || "").slice(0, 10)}
              required
            />
          </label>
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <Input
              type="checkbox"
              name="signedConfirmed"
              defaultChecked={Number(document.signed_confirmed || 0) === 1}
              className="h-4 w-4"
            />
            Đã ký / đóng dấu
          </label>
          <label className="text-sm md:col-span-2">
            File scan có chữ ký (bắt buộc)
            <Input name="files" type="file" required />
          </label>
          <div className="md:col-span-2">
            <Button disabled={loadingKey === "step8"}>
              {loadingKey === "step8" ? "Đang ban hành..." : "Ban hành"}
            </Button>
          </div>
        </form>
      </Block>

      <Block
        title="Bước 9 - Lưu trữ & hậu kiểm"
        step={9}
        enabled={!forceReadOnly && (permissions.get(9)?.canAct ?? false)}
        reason={
          forceReadOnly
            ? "Đang ở chế độ chỉ xem, không thể chỉnh sửa."
            : permissions.get(9)?.reason
        }
      >
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = e.currentTarget;
            const expireDate = (f.elements.namedItem("expireDate") as HTMLInputElement).value;
            const remindAfterDays = Number(
              (f.elements.namedItem("remindAfterDays") as HTMLInputElement).value || 180
            );
            submitJson(
              "step9",
              `/api/documents/${document.id}/archive`,
              { expireDate, remindAfterDays },
              "PUT"
            );
          }}
        >
          <label className="text-sm">
            Ngày hết hiệu lực
            <Input
              name="expireDate"
              type="date"
              defaultValue={(document.expire_date || "").slice(0, 10)}
            />
          </label>
          <label className="text-sm">
            Nhắc rà soát sau ... ngày
            <Input
              name="remindAfterDays"
              type="number"
              min={1}
              defaultValue={document.remind_after_days || 180}
            />
          </label>
          <div className="md:col-span-2">
            <Button disabled={loadingKey === "step9"}>
              {loadingKey === "step9" ? "Đang lưu..." : "Lưu trữ"}
            </Button>
          </div>
        </form>
      </Block>
    </div>
  );
}
