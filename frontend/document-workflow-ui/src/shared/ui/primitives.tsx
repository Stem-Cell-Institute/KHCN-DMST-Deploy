import {
  createContext,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import React from "react";
import clsx from "clsx";

/**
 * Generic UI primitives dung chung cho toan ung dung.
 * Khong duoc phu thuoc nguoc vao feature folder.
 */

export function Page({ children }: PropsWithChildren) {
  return <div className="min-h-screen bg-slate-100 p-4 md:p-6">{children}</div>;
}

export function Card({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={clsx("rounded-xl border border-slate-200 bg-white shadow-sm", className)}>
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "default",
}: PropsWithChildren<{ tone?: "default" | "success" | "danger" | "warning" }>) {
  const styles: Record<string, string> = {
    default: "bg-slate-100 text-slate-700",
    success: "bg-emerald-100 text-emerald-700",
    danger: "bg-rose-100 text-rose-700",
    warning: "bg-amber-100 text-amber-700",
  };
  return (
    <span className={clsx("inline-flex rounded-full px-2.5 py-1 text-xs font-medium", styles[tone])}>
      {children}
    </span>
  );
}

export function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "outline" | "danger" }
) {
  const { className, variant = "default", ...rest } = props;
  const styles = {
    default: "bg-primary-600 text-white hover:bg-primary-700",
    outline: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
  };
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed",
        styles[variant],
        className
      )}
    />
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        "w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-primary-600 focus:ring-2 focus:ring-primary-100",
        props.className
      )}
    />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={clsx(
        "w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-primary-600 focus:ring-2 focus:ring-primary-100",
        props.className
      )}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={clsx(
        "w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-primary-600 focus:ring-2 focus:ring-primary-100",
        props.className
      )}
    />
  );
}

export function DataTable({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>{headers.map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2 p-3">
      <Button variant="outline" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Trước</Button>
      <span className="text-xs text-slate-500">{`Trang ${page}/${Math.max(1, totalPages)}`}</span>
      <Button variant="outline" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>Sau</Button>
    </div>
  );
}

export function Tabs({
  tabs,
  value,
  onValueChange,
}: {
  tabs: Array<{ value: string; label: string }>;
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onValueChange(t.value)}
          className={clsx(
            "rounded-md px-3 py-1.5 text-sm",
            value === t.value ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

type ToastItem = { id: number; tone: "success" | "error"; message: string };
const ToastContext = createContext<{ push: (tone: ToastItem["tone"], message: string) => void } | null>(null);

export function ToastProvider({ children }: PropsWithChildren) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const api = useMemo(
    () => ({
      push(tone: ToastItem["tone"], message: string) {
        const id = Date.now() + Math.floor(Math.random() * 1000);
        setItems((prev) => [...prev, { id, tone, message }]);
        window.setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), 2600);
      },
    }),
    []
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-50 space-y-2">
        {items.map((it) => (
          <div
            key={it.id}
            className={clsx(
              "rounded-md px-3 py-2 text-sm text-white shadow-lg",
              it.tone === "success" ? "bg-emerald-600" : "bg-rose-600"
            )}
          >
            {it.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Xác nhận",
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-4 shadow-xl">
        <h3 className="text-base font-semibold text-slate-800">{title}</h3>
        <p className="mt-1 text-sm text-slate-500">{description}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Hủy</Button>
          <Button variant="danger" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}

export function FormDialog({
  open,
  title,
  description,
  children,
  onClose,
}: PropsWithChildren<{ open: boolean; title: string; description?: string; onClose: () => void }>) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-3xl rounded-xl bg-white p-4 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-800">{title}</h3>
            {description ? <p className="text-sm text-slate-500">{description}</p> : null}
          </div>
          <button type="button" className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
