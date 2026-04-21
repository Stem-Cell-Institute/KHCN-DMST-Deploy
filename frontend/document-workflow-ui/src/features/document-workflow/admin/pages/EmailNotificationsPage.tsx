import { useEffect, useState } from "react";
import {
  fetchEmailNotificationSettings,
  saveEmailNotificationSettings,
} from "@/features/document-workflow/use-cases/adminWorkflowApi";
import { Button, Card } from "@/components/ui";

const CHANNEL_LABELS: Record<string, string> = {
  enabled: "Gửi mail tình huống này",
  module_managers: "Module Manager (role module_manager)",
  master_admins: "Master Admin / Admin (role master_admin hoặc admin)",
  assigned_drafter: "Người được phân công soạn thảo",
  cc_module_managers: "CC: Module Manager",
  cc_master_admins: "CC: Master Admin",
  broad_role_users:
    "Thêm user role Drafter / Leader / Reviewer (chỉ khi cấu hình bước 5 = mở rộng)",
  all_registered_emails: "Mọi tài khoản có email trong hệ thống (ban hành)",
};

type CatalogItem = { key: string; title: string; when: string; recipientsNote: string };

export function EmailNotificationsPage() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [toggles, setToggles] = useState<Record<string, Record<string, boolean>>>({});
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    try {
      const d = await fetchEmailNotificationSettings();
      setCatalog(Array.isArray(d.catalog) ? d.catalog : []);
      setToggles(d.toggles && typeof d.toggles === "object" ? d.toggles : {});
      setEmailEnabled(!!d.email_enabled);
      setMsg("");
    } catch {
      setMsg("Không tải được cấu hình.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function setChannel(eventKey: string, channelKey: string, value: boolean) {
    setToggles((prev) => ({
      ...prev,
      [eventKey]: {
        ...(prev[eventKey] || {}),
        [channelKey]: value,
      },
    }));
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="text-lg font-semibold text-slate-800">
          Email — Quy trình ban hành văn bản nội bộ
        </h2>
        {msg ? <p className="mt-2 text-sm text-red-700">{msg}</p> : null}
      </Card>

      <Card className="p-4">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
          <input
            type="checkbox"
            checked={emailEnabled}
            onChange={(e) => setEmailEnabled(e.target.checked)}
          />
          Bật gửi email workflow (tổng)
        </label>
      </Card>

      {loading ? (
        <p className="text-sm text-slate-500">Đang tải…</p>
      ) : (
        catalog.map((c) => {
          const ev = toggles[c.key] || {};
          const rawKeys = Object.keys(ev);
          const keys = [
            ...(rawKeys.includes("enabled") ? ["enabled"] : []),
            ...rawKeys.filter((k) => k !== "enabled").sort(),
          ];
          if (!keys.length) return null;
          return (
            <Card key={c.key} className="p-4">
              <h3 className="text-base font-semibold text-slate-800">{c.title}</h3>
              <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                {keys.map((ch) => (
                  <label key={ch} className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={ev[ch] !== false}
                      onChange={(e) => setChannel(c.key, ch, e.target.checked)}
                    />
                    <span>{CHANNEL_LABELS[ch] || ch}</span>
                  </label>
                ))}
              </div>
            </Card>
          );
        })
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          onClick={async () => {
            try {
              await saveEmailNotificationSettings({ toggles, email_enabled: emailEnabled });
              setMsg("Đã lưu.");
              await reload();
            } catch {
              setMsg("Không lưu được.");
            }
          }}
        >
          Lưu cấu hình email
        </Button>
        <Button type="button" variant="outline" onClick={() => void reload()}>
          Tải lại
        </Button>
      </div>
    </div>
  );
}
