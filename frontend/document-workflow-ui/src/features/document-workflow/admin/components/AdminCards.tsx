import clsx from "clsx";
import type { PropsWithChildren } from "react";

/**
 * Admin-specific surface cards (sidebar card, section card).
 * Sat voi design admin panel cua feature document-workflow.
 */

export function AdminSidebarCard({ children, className }: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={clsx("rounded-xl border border-slate-800 bg-slate-950 text-slate-100 shadow-sm", className)}>
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
