import { Upload } from "lucide-react";
import { Button, Input } from "./ui";
import { api } from "@/lib/api";
import { useState, type FormEvent } from "react";

interface AttachmentUploaderProps {
  documentId: number;
  defaultStep: number;
  onDone: () => Promise<void> | void;
}

export function AttachmentUploader({ documentId, defaultStep, onDone }: AttachmentUploaderProps) {
  const [step, setStep] = useState(defaultStep);
  const [category, setCategory] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!files || files.length === 0) {
      setError("Vui lòng chọn ít nhất 1 file.");
      return;
    }
    if (step < 1 || step > 9) {
      setError("Step phải nằm trong khoảng 1-9.");
      return;
    }
    const formData = new FormData();
    formData.append("step", String(step));
    if (category.trim()) formData.append("category", category.trim());
    Array.from(files).forEach((f) => formData.append("files", f));
    setLoading(true);
    try {
      await api.post(`/api/documents/${documentId}/attachments`, formData);
      await onDone();
      setFiles(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload thất bại.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          Bước
          <Input
            type="number"
            min={1}
            max={9}
            value={step}
            onChange={(e) => setStep(Number(e.target.value))}
          />
        </label>
        <label className="text-sm">
          Category
          <Input value={category} onChange={(e) => setCategory(e.target.value)} />
        </label>
      </div>
      <label className="text-sm">
        File đính kèm
        <Input type="file" multiple onChange={(e) => setFiles(e.target.files)} />
      </label>
      {error ? <p className="text-sm text-rose-600">{error}</p> : null}
      <Button type="submit" disabled={loading}>
        <Upload className="mr-2 h-4 w-4" />
        {loading ? "Đang upload..." : "Upload file"}
      </Button>
    </form>
  );
}
