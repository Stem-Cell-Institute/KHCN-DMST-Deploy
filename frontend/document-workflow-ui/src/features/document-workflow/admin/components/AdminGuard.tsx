import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { fetchAdminMe } from "@/features/document-workflow/admin/use-cases/adminWorkflowApi";
import { parseRoles } from "@/lib/auth";
import type { UserRole } from "@/lib/types";

type AdminGuardProps = {
  children: ReactElement;
  requiredRoles?: UserRole[];
};

export function AdminGuard({ children, requiredRoles }: AdminGuardProps) {
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
    if (requiredRoles && requiredRoles.length) {
      return requiredRoles.some((role) => list.includes(role));
    }
    return list.includes("master_admin") || list.includes("module_manager") || list.includes("admin");
  }, [roles, requiredRoles]);

  if (roles === null) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Đang kiểm tra quyền truy cập...</div>;
  }
  if (!allowed) return <Navigate to="/documents" replace state={{ from: location.pathname }} />;
  return children;
}
