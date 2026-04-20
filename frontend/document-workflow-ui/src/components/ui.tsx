import clsx from "clsx";
import React, { type PropsWithChildren } from "react";

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
