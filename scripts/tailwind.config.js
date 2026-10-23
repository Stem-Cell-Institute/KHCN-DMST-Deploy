/**
 * Cấu hình build CSS tĩnh cho 3 trang admin dùng Tailwind.
 *
 * Trước đây 3 trang này nạp https://cdn.tailwindcss.com — trình biên dịch JIT chạy thẳng trong
 * trình duyệt. CSP của server (script-src 'self') chặn nó, nên giao diện mất style. Nay CSS được
 * build sẵn ra public/css/tailwind.css, không còn script ngoài.
 *
 * Đặt trong scripts/ vì express.static phục vụ cả thư mục gốc; scripts/ đã nằm trong danh sách
 * chặn tải (xem server.js), còn file mới thêm ở gốc thì tải về được.
 *
 * Build:  npm run build:css
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  // Đường dẫn tính từ vị trí file này, không phụ thuộc thư mục đang đứng khi chạy lệnh.
  content: [
    path.join(ROOT, 'admin-dashboard-demo.html'),
    path.join(ROOT, 'admin-quan-ly-tai-khoan.html'),
    path.join(ROOT, 'admin-system-logs-monitor.html'),
  ],
  theme: {
    extend: {
      // Giữ nguyên tailwind.config nội tuyến cũ của 3 trang.
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      // Chỉ admin-dashboard-demo.html khai báo; hiện chưa trang nào dùng tới lớp brand-*,
      // giữ lại để không mất ý định ban đầu — lớp không dùng thì không lọt vào file build.
      colors: {
        brand: { 50: '#eef2ff', 100: '#e0e7ff', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca' },
      },
    },
  },
  plugins: [],
};
