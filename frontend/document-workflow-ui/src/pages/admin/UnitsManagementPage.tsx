import { useEffect, useState } from "react";
import { createAdminUnit, deleteAdminUnit, fetchAdminUnits, updateAdminUnit } from "@/lib/api";
import { Button, Card, Input } from "@/components/ui";
import type { Unit } from "@/lib/types";

export function UnitsManagementPage() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [msg, setMsg] = useState("");

  async function reload() {
    setUnits(await fetchAdminUnits());
  }

  useEffect(() => {
    void reload().catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="text-lg font-semibold text-slate-800">Danh mục đơn vị</h2>
        {msg ? <p className="mt-1 text-sm text-slate-600">{msg}</p> : null}
      </Card>
      <Card className="p-4">
        <form
          className="grid gap-3 md:grid-cols-[180px_1fr_auto]"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = e.currentTarget;
            await createAdminUnit({
              code: (f.elements.namedItem("code") as HTMLInputElement).value || undefined,
              name: (f.elements.namedItem("name") as HTMLInputElement).value,
            });
            setMsg("Đã thêm đơn vị.");
            f.reset();
            await reload();
          }}
        >
          <Input name="code" placeholder="Mã đơn vị" />
          <Input name="name" placeholder="Tên đơn vị" required />
          <Button type="submit">Thêm</Button>
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
                await updateAdminUnit(u.id, {
                  code: (f.elements.namedItem(`code-${u.id}`) as HTMLInputElement).value || undefined,
                  name: (f.elements.namedItem(`name-${u.id}`) as HTMLInputElement).value,
                  active: (f.elements.namedItem(`active-${u.id}`) as HTMLInputElement).checked,
                });
                setMsg(`Đã cập nhật đơn vị #${u.id}.`);
                await reload();
              }}
            >
              <Input name={`code-${u.id}`} defaultValue={u.code || ""} />
              <Input name={`name-${u.id}`} defaultValue={u.name} required />
              <label className="flex items-center gap-2 text-sm">
                <input name={`active-${u.id}`} type="checkbox" defaultChecked={Number(u.active || 1) === 1} />
                Active
              </label>
              <div className="flex gap-2">
                <Button type="submit">Lưu</Button>
                <Button
                  type="button"
                  variant="danger"
                  onClick={async () => {
                    await deleteAdminUnit(u.id);
                    setMsg(`Đã xóa đơn vị #${u.id}.`);
                    await reload();
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
