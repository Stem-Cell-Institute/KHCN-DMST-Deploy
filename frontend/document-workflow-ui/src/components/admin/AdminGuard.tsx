import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { fetchAdminMe } from "@/lib/api";
import { parseRoles } from "@/lib/auth";

export function AdminGuard({ children }: { children: ReactElement }) {
  const [roles, setRoles] = useState<string[] | null>(null);
  const location = useLocation();

  useEffect(() => {
    void fetchAdminMe()
      .then((x) => setRoles(x.roles || []))
      .catch(() => setRoles([]));
  }, []);

  const allowed = useMemo(() => {
    if (!roles) return false;
    const list = parseRoles(roles);
    return list.includes("master_admin") || list.includes("module_manager") || list.includes("admin");
  }, [roles]);

  if (roles === null) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Đang kiểm tra quyền truy cập...</div>;
  }
  if (!allowed) return <Navigate to="/documents" replace state={{ from: location.pathname }} />;
  return children;
}
