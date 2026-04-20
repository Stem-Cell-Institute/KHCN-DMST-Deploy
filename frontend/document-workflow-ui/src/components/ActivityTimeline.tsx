import type { HistoryItem } from "@/lib/types";

export function ActivityTimeline({ items }: { items: HistoryItem[] }) {
  if (!items.length) {
    return <p className="text-sm text-slate-500">Chưa có lịch sử hoạt động.</p>;
  }
  return (
    <ol className="space-y-3">
      {items.map((h) => (
        <li key={h.id} className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-slate-700">{`B${h.step} - ${h.action}`}</span>
            <span className="text-xs text-slate-500">{h.created_at || ""}</span>
          </div>
          <p className="mt-1 text-slate-600">{h.note || "Không có ghi chú"}</p>
          {h.actor_name ? <p className="mt-1 text-xs text-slate-500">{`Thực hiện bởi: ${h.actor_name}`}</p> : null}
        </li>
      ))}
    </ol>
  );
}
