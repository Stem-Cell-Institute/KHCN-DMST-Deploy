import { Link, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { fetchMe } from "@/lib/api";
import { parseRoles } from "@/lib/auth";
import type { MeUser } from "@/lib/types";

/**
 * Thanh điều hướng trên trang workflow (/documents) — không nằm trong AdminLayout nên cần link tới Admin Panel.
 */
export function WorkflowTopNav() {
  const [me, setMe] = useState<MeUser | null>(null);
  const location = useLocation();

  useEffect(() => {
    void fetchMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  const roles = parseRoles(me?.role || []);
  const showAdmin =
    roles.includes("module_manager") || roles.includes("master_admin") || roles.includes("admin");

  const onList = location.pathname === "/documents" || location.pathname.endsWith("/documents");

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium text-slate-700">Quy trình văn bản nội bộ</span>
        <Link
          to="/documents"
          className={`rounded-md px-2 py-1 ${onList ? "bg-primary-100 text-primary-800" : "text-slate-600 hover:bg-slate-100"}`}
        >
          Danh sách hồ sơ
        </Link>
        <a
          href="/quy-trinh-van-ban-noi-bo.html"
          className="text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline"
        >
          Giao diện đầy đủ (legacy)
        </a>
      </div>
      {showAdmin ? (
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/module-settings"
            className="rounded-md bg-slate-800 px-3 py-2 font-medium text-white hover:bg-slate-900"
          >
            Admin Panel
          </Link>
        </div>
      ) : null}
    </div>
  );
}
