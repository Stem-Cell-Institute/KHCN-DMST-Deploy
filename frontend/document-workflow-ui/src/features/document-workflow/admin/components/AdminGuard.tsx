import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useLocation } from "react-router-dom";
import axios from "axios";
import { fetchAdminMe } from "@/features/document-workflow/use-cases/adminWorkflowApi";
import { parseRoles } from "@/lib/auth";
import type { UserRole } from "@/lib/types";

type AdminGuardProps = {
  children: ReactElement;
  requiredRoles?: UserRole[];
};

export function AdminGuard({ children, requiredRoles }: AdminGuardProps) {
  const [roles, setRoles] = useState<string[] | null>(null);
  const [accessCheckError, setAccessCheckError] = useState<string | null>(null);
  const location = useLocation();

  useEffect(() => {
    void fetchAdminMe()
      .then((x) => {
        setAccessCheckError(null);
        setRoles(x.roles || []);
      })
      .catch((err) => {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (status === 401 || status === 403) {
          setAccessCheckError(null);
          setRoles([]);
          return;
        }
        setAccessCheckError("Không kiểm tra được quyền truy cập Admin Panel. Vui lòng tải lại trang.");
        // Giữ giao diện tại chỗ để tránh cảm giác "link nhảy sai trang".
        setRoles([]);
      });
  }, []);

  const allowed = useMemo(() => {
    if (!roles) return false;
    const list = parseRoles(roles);
    if (requiredRoles && requiredRoles.length) {
      return requiredRoles.some((role) => list.includes(role));
    }
    return (
      list.includes("master_admin") ||
      list.includes("module_manager") ||
      list.includes("admin")
    );
  }, [roles, requiredRoles]);

  if (roles === null) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Đang kiểm tra quyền truy cập...
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-xl rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Không thể mở Admin Panel tại: {location.pathname}</p>
          <p className="mt-2">
            {accessCheckError ||
              "Tài khoản hiện tại chưa có quyền admin/module manager cho khu vực này."}
          </p>
          <p className="mt-2 text-amber-800">
            Vui lòng liên hệ quản trị hệ thống để cấp quyền nếu cần truy cập.
          </p>
        </div>
      </div>
    );
  }
  return children;
}
