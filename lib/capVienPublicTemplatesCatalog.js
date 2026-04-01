/**
 * Danh sách mã mẫu hồ sơ công khai (đề tài cấp Viện) — khớp giao diện trang tải mẫu.
 */
const CAP_VIEN_PUBLIC_TEMPLATE_CATALOG = [
  { code: 'SCI-TASK-01', label: 'Đơn đề xuất đề tài' },
  { code: 'SCI-TASK-02', label: 'Thuyết minh đề tài nghiên cứu khoa học' },
  { code: 'SCI-TASK-03', label: 'Dự toán kinh phí chi tiết' },
  { code: 'SCI-TASK-04', label: 'Phiếu kiểm tra hồ sơ hành chính' },
  { code: 'SCI-TASK-05', label: 'Phiếu phân công phản biện' },
  { code: 'SCI-TASK-06', label: 'Phiếu đánh giá của chuyên gia phản biện' },
  { code: 'SCI-TASK-07', label: 'Biên bản họp Hội đồng Khoa học xét duyệt đề tài' },
  { code: 'SCI-INST-QĐ', label: 'Quyết định phê duyệt đề tài KHCN cấp Viện' },
  { code: 'SCI-CONTRACT-01', label: 'Hợp đồng thực hiện nhiệm vụ khoa học và công nghệ' },
  { code: 'SCI-INST-07', label: 'Báo cáo tiến độ thực hiện đề tài KHCN' },
  { code: 'SCI-ACE-06', label: 'Đơn xin điều chỉnh nội dung/nhân sự/thời gian' },
  { code: 'SCI-FINAL-01', label: 'Đơn đề nghị nghiệm thu đề tài KHCN' },
  { code: 'SCI-FINAL-02', label: 'Báo cáo tổng kết đề tài KHCN' },
  { code: 'SCI-FINAL-03', label: 'Báo cáo tài chính quyết toán đề tài KHCN' },
  { code: 'SCI-FINAL-04', label: 'Phiếu đánh giá phản biện nghiệm thu đề tài KHCN' },
  { code: 'SCI-FINAL-05', label: 'Biên bản họp Hội đồng nghiệm thu đề tài KHCN' },
  { code: 'SCI-FINAL-06', label: 'Phiếu nhận xét và chấm điểm của thành viên Hội đồng nghiệm thu' },
  { code: 'SCI-FINAL-07', label: 'Quyết định công nhận kết quả nghiệm thu đề tài KHCN cấp Viện' },
  { code: 'SCI-FINAL-08', label: 'Biên bản thanh lý hợp đồng thực hiện nhiệm vụ KHCN' },
];

const allowed = new Set(CAP_VIEN_PUBLIC_TEMPLATE_CATALOG.map((x) => x.code));

function isAllowedTaskCode(code) {
  return typeof code === 'string' && allowed.has(code.trim());
}

function labelForTaskCode(code) {
  const row = CAP_VIEN_PUBLIC_TEMPLATE_CATALOG.find((x) => x.code === code);
  return row ? row.label : code;
}

module.exports = {
  CAP_VIEN_PUBLIC_TEMPLATE_CATALOG,
  isAllowedTaskCode,
  labelForTaskCode,
};
