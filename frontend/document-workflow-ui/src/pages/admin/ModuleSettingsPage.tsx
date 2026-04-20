import { useEffect, useState } from "react";
import { fetchModuleSettings, saveDocumentType, saveModuleSettings } from "@/lib/api";
import { Button, Card, Input } from "@/components/ui";

export function ModuleSettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [types, setTypes] = useState<Array<Record<string, unknown>>>([]);
  const [msg, setMsg] = useState("");

  async function reload() {
    const out = await fetchModuleSettings();
    setSettings(out.settings || {});
    setTypes(out.documentTypes || []);
  }

  useEffect(() => {
    void reload().catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="text-lg font-semibold text-slate-800">Cấu hình module</h2>
        {msg ? <p className="mt-1 text-sm text-slate-600">{msg}</p> : null}
      </Card>
      <Card className="p-4">
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = e.currentTarget;
            const payload = {
              default_assignment_days: Number((f.elements.namedItem("default_assignment_days") as HTMLInputElement).value),
              default_review_remind_days: Number((f.elements.namedItem("default_review_remind_days") as HTMLInputElement).value),
              email_enabled: (f.elements.namedItem("email_enabled") as HTMLInputElement).checked,
              step5_recipient_mode: (f.elements.namedItem("step5_recipient_mode") as HTMLSelectElement).value,
            };
            await saveModuleSettings(payload);
            setMsg("Đã lưu cấu hình module.");
            await reload();
          }}
        >
          <label className="text-sm">Deadline mặc định (ngày)
            <Input name="default_assignment_days" type="number" defaultValue={settings.default_assignment_days || "14"} />
          </label>
          <label className="text-sm">Nhắc rà soát trước hiệu lực (ngày)
            <Input name="default_review_remind_days" type="number" defaultValue={settings.default_review_remind_days || "180"} />
          </label>
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input name="email_enabled" type="checkbox" defaultChecked={settings.email_enabled === "1"} />
            Bật gửi email thông báo
          </label>
          <label className="text-sm md:col-span-2">
            Chế độ người nhận email khi duyệt bước 4 (chuyển bước 5)
            <select
              name="step5_recipient_mode"
              defaultValue={settings.step5_recipient_mode || "module_manager_assigned"}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="module_manager_assigned">Module Manager + Người soạn thảo được phân công</option>
              <option value="broad_roles">Toàn bộ role Drafter + Leader + Reviewer + Người soạn thảo</option>
            </select>
          </label>
          <p className="text-xs text-slate-500 md:col-span-2">
            Hệ thống đang dùng mẫu nội dung và danh sách người nhận tự động theo logic nghiệp vụ từng bước.
          </p>
          <div className="md:col-span-2">
            <Button type="submit">Lưu cấu hình</Button>
          </div>
        </form>
      </Card>
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">Loại văn bản</h3>
        <div className="space-y-2">
          {types.map((t) => (
            <form
              key={String(t.id)}
              className="grid gap-2 rounded border border-slate-200 p-2 md:grid-cols-[160px_1fr_120px_120px_auto]"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = e.currentTarget;
                await saveDocumentType({
                  id: Number(t.id),
                  code: (f.elements.namedItem(`code-${t.id}`) as HTMLInputElement).value,
                  name: (f.elements.namedItem(`name-${t.id}`) as HTMLInputElement).value,
                  is_active: (f.elements.namedItem(`active-${t.id}`) as HTMLInputElement).checked,
                  sort_order: Number((f.elements.namedItem(`sort-${t.id}`) as HTMLInputElement).value || 0),
                });
                setMsg(`Đã lưu loại văn bản #${String(t.id)}.`);
                await reload();
              }}
            >
              <Input name={`code-${t.id}`} defaultValue={String(t.code || "")} />
              <Input name={`name-${t.id}`} defaultValue={String(t.name || "")} />
              <Input name={`sort-${t.id}`} type="number" defaultValue={String(t.sort_order || 0)} />
              <label className="flex items-center gap-2 text-sm">
                <input name={`active-${t.id}`} type="checkbox" defaultChecked={Number(t.is_active || 1) === 1} />
                Active
              </label>
              <Button type="submit">Lưu</Button>
            </form>
          ))}
          <form
            className="grid gap-2 rounded border border-dashed border-slate-300 p-2 md:grid-cols-[160px_1fr_120px_120px_auto]"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = e.currentTarget;
              await saveDocumentType({
                code: (f.elements.namedItem("code-new") as HTMLInputElement).value,
                name: (f.elements.namedItem("name-new") as HTMLInputElement).value,
                is_active: true,
                sort_order: Number((f.elements.namedItem("sort-new") as HTMLInputElement).value || 0),
              });
              setMsg("Đã thêm loại văn bản.");
              f.reset();
              await reload();
            }}
          >
            <Input name="code-new" placeholder="code" required />
            <Input name="name-new" placeholder="Tên loại văn bản" required />
            <Input name="sort-new" type="number" placeholder="sort" />
            <div />
            <Button type="submit">Thêm</Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
