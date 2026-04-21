import clsx from "clsx";
import type { PropsWithChildren } from "react";
export {
  ConfirmDialog,
  DataTable,
  FormDialog,
  Pagination,
  Tabs,
  ToastProvider,
  useToast,
} from "@/shared/ui/primitives";

export function AdminSidebarCard({ children, className }: PropsWithChildren<{ className?: string }>) {
  return (
    <div
      className={clsx(
        "rounded-xl border border-slate-800 bg-slate-950 text-slate-100 shadow-sm",
        className
      )}
    >
      {children}
    </div>
  );
}

export function AdminSectionCard({ children, className }: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={clsx("rounded-xl border border-slate-200 bg-white shadow-sm", className)}>
      {children}
    </div>
  );
}
