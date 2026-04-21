import { useEffect, useState } from "react";
import { fetchAuditLogs } from "@/features/document-workflow/use-cases/adminWorkflowApi";
import type { AuditLogItem } from "@/lib/types";
import { Button, Card, Input } from "@/components/ui";

export function AuditLogsPage() {
  const [rows, setRows] = useState<AuditLogItem[]>([]);
  const [filters, setFilters] = useState({ userId: "", action: "", from: "", to: "" });

  async function reload() {
    setRows(await fetchAuditLogs(filters));
  }

  useEffect(() => {
    void reload().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="text-lg font-semibold text-slate-800">Nhật ký hệ thống</h2>
        <form
          className="mt-3 grid gap-2 md:grid-cols-[120px_1fr_160px_160px_auto]"
          onSubmit={async (e) => {
            e.preventDefault();
            await reload();
          }}
        >
          <Input
            placeholder="User ID"
            value={filters.userId}
            onChange={(e) => setFilters((p) => ({ ...p, userId: e.target.value }))}
          />
          <Input
            placeholder="Action"
            value={filters.action}
            onChange={(e) => setFilters((p) => ({ ...p, action: e.target.value }))}
          />
          <Input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters((p) => ({ ...p, from: e.target.value }))}
          />
          <Input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters((p) => ({ ...p, to: e.target.value }))}
          />
          <Button type="submit">Lọc</Button>
        </form>
      </Card>
      <Card className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2 text-left">Thời gian</th>
              <th className="px-3 py-2 text-left">Người thực hiện</th>
              <th className="px-3 py-2 text-left">Hành động</th>
              <th className="px-3 py-2 text-left">Đối tượng</th>
              <th className="px-3 py-2 text-left">Chi tiết</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{r.created_at}</td>
                <td className="px-3 py-2">{r.user_email || "system"}</td>
                <td className="px-3 py-2">{r.action}</td>
                <td className="px-3 py-2">{`${r.target_type || "-"} #${r.target_id || "-"}`}</td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {r.new_value || r.old_value || "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
