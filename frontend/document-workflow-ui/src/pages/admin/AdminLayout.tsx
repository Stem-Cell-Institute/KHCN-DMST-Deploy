import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { fetchAdminMe } from "@/lib/api";
import { parseRoles } from "@/lib/auth";
import { Page } from "@/components/ui";
import { AdminSidebarCard } from "@/components/admin/AdminPrimitives";

type AdminMe = {
  user: { fullname?: string; email?: string };
  roles: string[];
  isMasterAdmin: boolean;
  isModuleManager: boolean;
};

export function AdminLayout() {
  const [me, setMe] = useState<AdminMe | null>(null);

  useEffect(() => {
    void fetchAdminMe().then(setMe).catch(() => setMe(null));
  }, []);

  const roles = useMemo(() => parseRoles(me?.roles || []), [me]);
  const isMaster = roles.includes("master_admin");
  const isManager = isMaster || roles.includes("module_manager");

  const menu = [
    { to: "/admin/dashboard", label: "Dashboard (dev)", show: isMaster },
    { to: "/admin/users", label: "master admin (dev)", show: isMaster },
    { to: "/admin/units", label: "Danh mục đơn vị", show: isManager },
    { to: "/admin/module-settings", label: "Cấu hình module", show: isManager },
    { to: "/admin/audit-logs", label: "Nhật ký hệ thống", show: isMaster },
  ].filter((x) => x.show);

  return (
    <Page>
      <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-[260px_1fr]">
        <AdminSidebarCard className="p-3">
          <p className="mb-2 text-sm font-semibold text-slate-100">Admin Panel</p>
          <div className="mb-3 rounded-md bg-slate-900 p-2 text-xs text-slate-300">
            {me ? `${me.user.fullname || me.user.email || "User"}` : "Đang tải thông tin..."}
          </div>
          <nav className="space-y-1">
            {menu.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `block rounded-md px-3 py-2 text-sm ${isActive ? "bg-primary-600 text-white" : "text-slate-200 hover:bg-slate-900"}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <a
            href="/quy-trinh-van-ban-noi-bo.html"
            className="mt-3 block rounded-md border border-slate-700 px-3 py-2 text-center text-sm text-slate-200 hover:bg-slate-900"
          >
            ← Về STIMS Workflow
          </a>
          <a
            href="/index.html"
            className="mt-2 block rounded-md border border-slate-700 px-3 py-2 text-center text-sm text-slate-200 hover:bg-slate-900"
          >
            ← Về trang chủ
          </a>
        </AdminSidebarCard>
        <Outlet />
      </div>
    </Page>
  );
}
