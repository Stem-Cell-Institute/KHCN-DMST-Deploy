import { useEffect, useState } from "react";
import { fetchAdminDashboard } from "@/features/document-workflow/use-cases/adminWorkflowApi";
import type { AdminStats, AuditLogItem } from "@/lib/types";
import { Tabs } from "@/shared/ui/primitives";
import { AdminSectionCard } from "@/features/document-workflow/admin/components/AdminCards";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

export function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [recent, setRecent] = useState<AuditLogItem[]>([]);
  const [tab, setTab] = useState("month");

  useEffect(() => {
    void fetchAdminDashboard()
      .then((d) => {
        setStats(d.stats);
        setRecent(d.recentAudit || []);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <AdminSectionCard className="p-4">
        <h2 className="text-lg font-semibold text-slate-800">Dashboard quản trị hệ thống</h2>
        <p className="text-sm text-slate-500">
          Tổng quan người dùng, hồ sơ đang xử lý và quá hạn.
        </p>
      </AdminSectionCard>
      <div className="grid gap-3 md:grid-cols-3">
        <AdminSectionCard className="p-4">
          <p className="text-sm text-slate-500">Tổng người dùng</p>
          <p className="text-2xl font-semibold text-slate-800">{stats?.usersCount ?? "—"}</p>
        </AdminSectionCard>
        <AdminSectionCard className="p-4">
          <p className="text-sm text-slate-500">Hồ sơ đang xử lý</p>
          <p className="text-2xl font-semibold text-slate-800">
            {stats?.processingCount ?? "—"}
          </p>
        </AdminSectionCard>
        <AdminSectionCard className="p-4">
          <p className="text-sm text-slate-500">Hồ sơ trễ hạn</p>
          <p className="text-2xl font-semibold text-rose-700">{stats?.overdueCount ?? "—"}</p>
        </AdminSectionCard>
      </div>
      <AdminSectionCard className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">Thống kê hồ sơ</h3>
          <Tabs
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: "month", label: "Theo tháng" },
              { value: "type", label: "Theo loại văn bản" },
            ]}
          />
        </div>
        <div className="h-72">
          {tab === "month" ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats?.byMonth || []}>
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="count" fill="#2563eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={stats?.byType || []}
                  dataKey="count"
                  nameKey="doc_type"
                  outerRadius={100}
                  label
                >
                  {(stats?.byType || []).map((_, idx) => (
                    <Cell
                      key={idx}
                      fill={["#2563eb", "#16a34a", "#f59e0b", "#ef4444", "#8b5cf6"][idx % 5]}
                    />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </AdminSectionCard>
      <AdminSectionCard className="p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">Hoạt động gần đây</h3>
        <div className="space-y-2">
          {recent.map((a) => (
            <div key={a.id} className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <div className="font-medium text-slate-700">{a.action}</div>
              <div className="text-xs text-slate-500">{`${a.user_email || "system"} • ${a.created_at}`}</div>
            </div>
          ))}
        </div>
      </AdminSectionCard>
    </div>
  );
}
