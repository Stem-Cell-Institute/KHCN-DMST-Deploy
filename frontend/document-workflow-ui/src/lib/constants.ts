import type { WorkflowStep } from "./types";

export const STEP_LABELS: Record<WorkflowStep, string> = {
  1: "Đề xuất xây dựng",
  2: "Phân công soạn thảo",
  3: "Soạn thảo dự thảo lần 1",
  4: "Thẩm định (tiền kiểm)",
  5: "Lấy ý kiến góp ý",
  6: "Hoàn thiện dự thảo",
  7: "Trình ký ban hành",
  8: "Ban hành, công bố",
  9: "Lưu trữ & hậu kiểm",
};

export const DOC_TYPE_OPTIONS = [
  { value: "quy_che", label: "Quy chế" },
  { value: "quy_dinh", label: "Quy định" },
  { value: "noi_quy", label: "Nội quy" },
  { value: "huong_dan", label: "Hướng dẫn" },
];
