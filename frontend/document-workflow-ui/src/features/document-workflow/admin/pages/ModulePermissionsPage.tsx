import { useEffect, useState } from "react";
import {
  fetchModulePermissions,
  updateModuleUserRoles,
} from "@/features/document-workflow/use-cases/adminWorkflowApi";
import { Button, Card, Input } from "@/components/ui";

export function ModulePermissionsPage() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function reload() {
    setError("");
    setLoading(true);
    try {
      const data = await fetchModulePermissions();
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setRows([]);
      setError(e instanceof Error ? e.message : "Không tải được danh sách phân quyền.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload().catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="text-lg font-semibold text-slate-800">Phân quyền module văn bản</h2>
        <p className="text-sm text-slate-500">
          Master Admin gán hoặc thu hồi module_manager, leader, reviewer, drafter,
          proposer.
        </p>
        {msg ? <p className="mt-2 text-sm text-slate-600">{msg}</p> : null}
      </Card>
      <div className="space-y-3">
        {loading ? <Card className="p-4 text-sm text-slate-500">Đang tải dữ liệu phân quyền...</Card> : null}
        {!loading && error ? <Card className="p-4 text-sm text-rose-700">{`Lỗi tải dữ liệu: ${error}`}</Card> : null}
        {!loading && !error && rows.length === 0 ? (
          <Card className="p-4 text-sm text-slate-500">
            Chưa có người dùng nào trong phạm vi phân quyền module.
          </Card>
        ) : null}
        {!loading &&
          !error &&
          rows.map((u) => (
            <Card key={String(u.id)} className="p-4">
              <form
                className="grid gap-3 md:grid-cols-[1fr_2fr_auto]"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = e.currentTarget;
                  const roles = (f.elements.namedItem("roles") as HTMLInputElement).value
                    .split(/[,\s;|]+/)
                    .map((x) => x.trim())
                    .filter(Boolean);
                  await updateModuleUserRoles(Number(u.id), roles);
                  setMsg(`Đã cập nhật role cho ${String(u.email || u.id)}.`);
                  await reload();
                }}
              >
                <div className="text-sm">
                  <p className="font-medium text-slate-700">
                    {String(u.fullname || "") || String(u.email || "")}
                  </p>
                  <p className="text-slate-500">{String(u.email || "")}</p>
                </div>
                <Input name="roles" defaultValue={String(u.role || "")} />
                <Button type="submit">Lưu role</Button>
              </form>
            </Card>
          ))}
      </div>
    </div>
  );
}
