# Khởi động lại Server để nhận API mới

Khi thêm API mới (ví dụ: POST /api/cooperation/mou/submit), server cần được **khởi động lại** để load code mới.

## Các bước

1. **Dừng server hiện tại**
   - Mở terminal đang chạy `node server.js`
   - Nhấn **Ctrl + C** để dừng

2. **Chạy lại server**
   ```bash
   node server.js
   ```

3. **Kiểm tra**
   - Mở http://localhost:3000/api/health — nếu trả về OK thì server đã chạy
   - Thử lại nút "Gửi Phòng KHCN&QHĐN" trong form Đề xuất Thỏa thuận

## Lưu ý

- Nếu port 3000 đang bị chiếm: tắt process cũ (Task Manager hoặc `taskkill`) rồi chạy lại `node server.js`.

### Đặt lịch CRD — API vai trò (`/api/crd/admin/role-defs`)

Nếu giao diện báo **404** / *«Không tìm thấy API: POST /crd/admin/role-defs»*, nguyên nhân gần như luôn là **tiến trình `node server.js` chưa được khởi động lại** sau khi cập nhật `server.js`. Dừng server (Ctrl+C) và chạy lại `node server.js`, rồi tải lại trang (Ctrl+F5).

Sau khi backend mới chạy, gọi API không có cookie/token sẽ trả **401** «Chưa đăng nhập» — đó là bình thường; **401** nghĩa là route đã tồn tại, khác **404**.
