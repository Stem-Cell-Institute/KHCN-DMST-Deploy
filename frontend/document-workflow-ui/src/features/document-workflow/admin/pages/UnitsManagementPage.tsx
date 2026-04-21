import axios from "axios";
import { useEffect, useState } from "react";
import {
  createAdminUnit,
  deleteAdminUnit,
  fetchAdminUnits,
  updateAdminUnit,
} from "@/features/document-workflow/use-cases/adminWorkflowApi";
import { Button, Card, Input } from "@/components/ui";
import type { Unit } from "@/lib/types";

function apiErr(e: unknown, fallback: string) {
  if (axios.isAxiosError(e)) {
    const data = e.response?.data;
    if (
      data &&
      typeof data === "object" &&
      typeof (data as { message?: string }).message === "string"
    ) {
      return (data as { message: string }).message;
    }
    if (typeof data === "string" && data.trim()) return data.trim().slice(0, 300);
    if (e.response?.status === 401)
      return "Phiên đăng nhập hết hạn hoặc chưa đăng nhập. Vui lòng đăng nhập lại.";
    if (e.response?.status === 403)
      return "Không đủ quyền (cần Module Manager hoặc Master Admin).";
    if (e.code === "ECONNABORTED") return "Hết thời gian chờ máy chủ.";
    if (e.message) return e.message;
  }
  if (e instanceof Error) return e.message;
  return fallback;
}

export function UnitsManagementPage() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [msg, setMsg] = useState("");
  const [msgTone, setMsgTone] = useState<"neutral" | "danger">("neutral");
  const [adding, setAdding] = useState(false);

  async function reload() {
    try {
      setUnits(await fetchAdminUnits());
    } catch (e) {
      setMsgTone("danger");
      setMsg(apiErr(e, "Không tải được danh sách đơn vị."));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="text-lg font-semibold text-slate-800">Danh mục đơn vị</h2>
        {msg ? (
          <p
            className={`mt-1 text-sm ${
              msgTone === "danger" ? "text-red-700" : "text-slate-600"
            }`}
          >
            {msg}
          </p>
        ) : null}
      </Card>
      <Card className="p-4">
        <form
          className="grid gap-3 md:grid-cols-[180px_1fr_auto]"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = e.currentTarget;
            const fd = new FormData(f);
            const codeRaw = String(fd.get("unit_code") ?? "").trim();
            const nameRaw = String(fd.get("unit_name") ?? "").trim();
            if (!nameRaw) {
              setMsgTone("danger");
              setMsg("Vui lòng nhập tên đơn vị.");
              return;
            }
            try {
              setAdding(true);
              await createAdminUnit({
                code: codeRaw || undefined,
                name: nameRaw,
              });
              setMsgTone("neutral");
              setMsg("Đã thêm đơn vị.");
              f.reset();
              await reload();
            } catch (err) {
              setMsgTone("danger");
              setMsg(apiErr(err, "Không thêm được đơn vị."));
            } finally {
              setAdding(false);
            }
          }}
        >
          <Input name="unit_code" placeholder="Mã đơn vị" autoComplete="off" />
          <Input name="unit_name" placeholder="Tên đơn vị" required autoComplete="off" />
          <Button type="submit" disabled={adding}>
            {adding ? "Đang thêm…" : "Thêm"}
          </Button>
        </form>
      </Card>
      <div className="space-y-2">
        {units.map((u) => (
          <Card key={u.id} className="p-4">
            <form
              className="grid gap-3 md:grid-cols-[160px_1fr_auto_auto]"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = e.currentTarget;
                try {
                  await updateAdminUnit(u.id, {
                    code:
                      (f.elements.namedItem(`code-${u.id}`) as HTMLInputElement).value ||
                      undefined,
                    name: (f.elements.namedItem(`name-${u.id}`) as HTMLInputElement).value,
                    active: (f.elements.namedItem(`active-${u.id}`) as HTMLInputElement).checked,
                  });
                  setMsgTone("neutral");
                  setMsg(`Đã cập nhật đơn vị #${u.id}.`);
                  await reload();
                } catch (err) {
                  setMsgTone("danger");
                  setMsg(apiErr(err, "Không cập nhật được đơn vị."));
                }
              }}
            >
              <Input name={`code-${u.id}`} defaultValue={u.code || ""} />
              <Input name={`name-${u.id}`} defaultValue={u.name} required />
              <label className="flex items-center gap-2 text-sm">
                <input
                  name={`active-${u.id}`}
                  type="checkbox"
                  defaultChecked={Number(u.active || 1) === 1}
                />
                Active
              </label>
              <div className="flex gap-2">
                <Button type="submit">Lưu</Button>
                <Button
                  type="button"
                  variant="danger"
                  onClick={async () => {
                    try {
                      await deleteAdminUnit(u.id);
                      setMsgTone("neutral");
                      setMsg(`Đã xóa đơn vị #${u.id}.`);
                      await reload();
                    } catch (err) {
                      setMsgTone("danger");
                      setMsg(apiErr(err, "Không xóa được đơn vị."));
                    }
                  }}
                >
                  Xóa
                </Button>
              </div>
            </form>
          </Card>
        ))}
      </div>
    </div>
  );
}
