import clsx from "clsx";
import { STEP_LABELS } from "@/lib/constants";
import type { WorkflowStep } from "@/lib/types";

export function DocumentStepper({ currentStep }: { currentStep: WorkflowStep }) {
  const steps = Object.entries(STEP_LABELS).map(([key, label]) => ({
    step: Number(key) as WorkflowStep,
    label,
  }));

  return (
    <div className="grid gap-2 md:grid-cols-9">
      {steps.map((item) => {
        const isDone = item.step < currentStep;
        const isCurrent = item.step === currentStep;
        return (
          <div
            key={item.step}
            className={clsx(
              "rounded-lg border px-2 py-2 text-center text-xs",
              isCurrent && "border-primary-600 bg-primary-50 text-primary-700",
              isDone && "border-emerald-300 bg-emerald-50 text-emerald-700",
              !isDone && !isCurrent && "border-slate-200 bg-slate-50 text-slate-600"
            )}
          >
            <div className="font-semibold">{`Bước ${item.step}`}</div>
            <div className="mt-1 line-clamp-2">{item.label}</div>
          </div>
        );
      })}
    </div>
  );
}
