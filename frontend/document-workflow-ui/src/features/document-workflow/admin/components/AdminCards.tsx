import clsx from "clsx";
import { forwardRef, type PropsWithChildren } from "react";

export const AdminSidebarCard = forwardRef<HTMLDivElement, PropsWithChildren<{ className?: string }>>(
  ({ children, className }, ref) => {
    return (
      <div
        ref={ref}
        className={clsx(
          "rounded-xl border border-slate-800 bg-slate-950 text-slate-100 shadow-sm",
          className
        )}
      >
        {children}
      </div>
    );
  }
);
AdminSidebarCard.displayName = "AdminSidebarCard";

export const AdminSectionCard = forwardRef<
  HTMLDivElement,
  PropsWithChildren<{ className?: string }>
>(({ children, className }, ref) => {
  return (
    <div ref={ref} className={clsx("rounded-xl border border-slate-200 bg-white shadow-sm", className)}>
      {children}
    </div>
  );
});
AdminSectionCard.displayName = "AdminSectionCard";
