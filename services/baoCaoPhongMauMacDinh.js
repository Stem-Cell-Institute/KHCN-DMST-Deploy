/**
 * Biểu mẫu mặc định của module Báo cáo phòng ban — tái hiện mẫu "Báo cáo kết quả hoạt động tháng"
 * của Viện (file Word "Báo cáo KHCN tháng 9.docx"), để module có sẵn mẫu dùng ngay khi triển khai.
 *
 * Được nạp MỘT LẦN khi bảng bcp_mau còn trống (services/baoCaoPhongSchema.js). Sau đó người quản
 * lý module tự điều chỉnh trong giao diện: mẫu trong DB mới là bản đang dùng, file này chỉ là điểm
 * khởi đầu. Sửa file này KHÔNG làm đổi mẫu đã nạp.
 *
 * Phần đầu thư ("Tên Phòng/Ban") không nằm ở đây vì lấy tự động từ phòng được giao. Phần chữ ký
 * (Người lập báo cáo / Trưởng phòng / Viện trưởng) do bộ xuất Word/PDF tự thêm.
 *
 * Khóa ô (key) cố định, đặt có nghĩa: bộ xuất dùng `nguoi_phu_trach` để in tên dưới ô chữ ký
 * Trưởng phòng, nên đừng đổi khóa đó khi không cần.
 */

const TEN_MAU_MAC_DINH = 'Báo cáo kết quả hoạt động tháng (mẫu Viện)';
const MO_TA_MAU_MAC_DINH = 'Mẫu báo cáo tháng của các phòng gửi Viện trưởng: tổng quan, kết quả theo KPI, đánh giá, tồn đọng và kế hoạch tháng tới.';

/** Cột dùng chung cho hai bảng công việc. */
const COT_CONG_VIEC = (cotDau) => [
  cotDau,
  { key: 'viec_cu_the', kieu: 'textarea', nhan: 'Các việc cụ thể đã làm' },
  { key: 'ket_qua', kieu: 'textarea', nhan: 'Kết quả đạt được (Sản phẩm/Minh chứng)' },
  { key: 'muc_do', kieu: 'number', nhan: 'Mức độ hoàn thành (%)', min: 0, max: 100, phan_tram: true },
  { key: 'ghi_chu', kieu: 'textarea', nhan: 'Tự đánh giá / Ghi chú (giải trình nếu chậm tiến độ)' },
];

const TRUONG_MAC_DINH = [
  { key: 'nguoi_phu_trach', kieu: 'text', nhan: 'Trưởng phòng / Người phụ trách', bat_buoc: true },
  { key: 'ky_tu_ngay', kieu: 'date', nhan: 'Kỳ báo cáo từ ngày', bat_buoc: true },
  { key: 'ky_den_ngay', kieu: 'date', nhan: 'Kỳ báo cáo đến ngày', bat_buoc: true },

  {
    key: 'p1', kieu: 'section', nhan: 'I. Tổng quan tình hình hoạt động trong tháng',
    tro_giup: 'Đánh giá ngắn gọn về thuận lợi, khó khăn chung tác động đến tiến độ và chất lượng công việc của Phòng trong tháng qua.',
  },
  { key: 'thuan_loi', kieu: 'textarea', nhan: 'Thuận lợi' },
  { key: 'kho_khan_chung', kieu: 'textarea', nhan: 'Khó khăn' },

  { key: 'p2', kieu: 'section', nhan: 'II. Kết quả thực hiện công việc theo KPI' },
  {
    key: 'cv_thuong_xuyen', kieu: 'bang',
    nhan: '1. Nhóm công việc thường xuyên (theo chức năng, nhiệm vụ và KPI đã giao)',
    tro_giup: 'Bấm "Thêm mục tiêu / nhóm công việc" để tạo nhóm (A, B…), rồi "Thêm dòng" cho từng việc cụ thể bên dưới.',
    cho_phep_nhom: true,
    nhan_nhom: 'Mục tiêu / Nhóm công việc',
    cot: COT_CONG_VIEC({ key: 'hang_muc', kieu: 'text', nhan: 'Hạng mục công việc / Chỉ tiêu KPI' }),
  },
  {
    key: 'cv_dot_xuat', kieu: 'bang',
    nhan: '2. Nhóm công việc đột xuất / Phát sinh theo chỉ đạo của Ban Giám đốc',
    cho_phep_nhom: false,
    cot: COT_CONG_VIEC({ key: 'ten_cong_viec', kieu: 'text', nhan: 'Tên công việc phát sinh' }),
  },

  { key: 'p3', kieu: 'section', nhan: 'III. Đánh giá chung về mức độ hoàn thành KPI tháng' },
  {
    key: 'tong_hop_kpi', kieu: 'tong_hop', nhan: 'Thống kê tự động từ hai bảng công việc ở mục II',
    tro_giup: 'Tự tính từ cột "Mức độ hoàn thành (%)". Dòng chưa ghi mức độ được tính là chưa thực hiện.',
    bang: ['cv_thuong_xuyen', 'cv_dot_xuat'],
  },
  { key: 'tu_danh_gia', kieu: 'select', nhan: 'Tự đánh giá hiệu quả hoạt động của Phòng (A/B/C)', lua_chon: ['A', 'B', 'C'], bat_buoc: true },

  { key: 'p4', kieu: 'section', nhan: 'IV. Tồn đọng, vướng mắc và kiến nghị' },
  { key: 'ton_dong', kieu: 'textarea', nhan: '1. Các công việc còn tồn đọng (nguyên nhân & hướng giải quyết)' },
  { key: 'kien_nghi', kieu: 'textarea', nhan: '2. Kiến nghị, đề xuất với Ban Giám đốc (hỗ trợ nhân sự, cơ sở vật chất, tài chính…)' },

  { key: 'p5', kieu: 'section', nhan: 'V. Kế hoạch hoạt động trọng tâm tháng tới' },
  {
    key: 'ke_hoach', kieu: 'bang', nhan: 'Kế hoạch tháng tới',
    cot: [
      { key: 'ten_cong_viec', kieu: 'text', nhan: 'Tên công việc / Mục tiêu KPI tháng tới' },
      { key: 'thoi_han', kieu: 'date', nhan: 'Thời gian dự kiến hoàn thành' },
      { key: 'phu_trach', kieu: 'text', nhan: 'Người/Nhóm phụ trách' },
      { key: 'ho_tro', kieu: 'text', nhan: 'Hỗ trợ yêu cầu (nếu có)' },
    ],
  },
];

module.exports = { TEN_MAU_MAC_DINH, MO_TA_MAU_MAC_DINH, TRUONG_MAC_DINH };
