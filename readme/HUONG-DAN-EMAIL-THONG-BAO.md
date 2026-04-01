# Hướng dẫn gửi email thông báo ở các giai đoạn đề tài

## 1. Bạn cần làm gì để gửi được email

### Bước 1: Cấu hình SMTP trong file `.env`

Tạo (hoặc sửa) file **`.env`** trong thư mục gốc dự án (cùng cấp với `server.js`), với nội dung:

```env
# SMTP — bắt buộc để hệ thống gửi được email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=your-email@gmail.com

# URL trang web (để link trong email trỏ đúng địa chỉ)
BASE_URL=http://localhost:3000
```

**Lưu ý:**

- **Gmail:** Thay `your-email@gmail.com` và `your-app-password` bằng tài khoản Gmail thật. Cần dùng [Mật khẩu ứng dụng](https://support.google.com/accounts/answer/185833) (App Password), không dùng mật khẩu đăng nhập thường.
- **Email khác (Outlook, Yahoo, SMTP riêng):** Đổi `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` theo hướng dẫn của nhà cung cấp; `SMTP_USER` và `SMTP_PASS` là tài khoản gửi thư.

### Bước 2: Khởi động lại backend

Sau khi lưu `.env`:

1. Dừng server hiện tại (Ctrl+C trong terminal đang chạy `node server.js`).
2. Chạy lại: `node server.js`.
3. Nếu cấu hình đúng, khi khởi động sẽ không còn dòng cảnh báo "Chưa cấu hình SMTP".

### Bước 3: Danh sách người nhận thông báo

- Vào trang **Quản trị** (quan-tri.html), đăng nhập bằng tài khoản Admin.
- Kéo xuống mục **"Danh sách người nhận email thông báo"**.
- **Thêm** các email sẽ nhận mọi thông báo (hồ sơ mới, yêu cầu bổ sung, kết quả họp, v.v.): thêm từng người (email + họ tên tùy chọn), bấm **Thêm người nhận**.
- **Xóa** khi không cần nhận nữa: bấm **Xóa** ở dòng tương ứng.

**Quy tắc:** Mọi thông báo theo giai đoạn đề tài sẽ gửi tới **danh sách này**. Nếu danh sách trống, hệ thống dùng email từ vai trò Hội đồng trong DB (Chủ tịch, Thư ký, Thành viên, Admin).

---

## 2. Các giai đoạn có gửi email và nội dung như thế nào

### A. Hồ sơ SCI-ACE (nhiệm vụ KHCN cơ sở)

| Giai đoạn / Sự kiện | Người nhận | Tiêu đề email | Nội dung chính |
|---------------------|------------|----------------|-----------------|
| **Nộp hồ sơ mới** | Danh sách người nhận thông báo (Hội đồng) | [SCI-ACE] Hồ sơ mới được nộp: &lt;tên hồ sơ&gt; | Nghiên cứu viên &lt;email&gt; vừa nộp hồ sơ; link vào khu vực Hội đồng để xem và tải hồ sơ. |
| **GĐ3 – Kết quả kiểm tra hồ sơ** (Hợp lệ / Yêu cầu bổ sung / Không chấp thuận) | (1) Nghiên cứu viên nộp hồ sơ; (2) Danh sách người nhận | (1) [SCI-ACE] Kết quả kiểm tra hồ sơ: &lt;tên&gt;; (2) [SCI-ACE] Thư ký đã xử lý GĐ3 – Hồ sơ: &lt;tên&gt; | Kết quả (Hợp lệ / Yêu cầu bổ sung / …), nhận xét (nếu có); link Hội đồng / Hồ sơ của tôi. |
| **GĐ4 – Phân công phản biện** | (1) Từng phản biện được phân công; (2) Danh sách người nhận | (1) [SCI-ACE] Bạn được phân công phản biện: &lt;tên&gt;; (2) [SCI-ACE] Chủ tịch đã phân công phản biện (GĐ4) – Hồ sơ: &lt;tên&gt; | Chủ tịch đã phân công; phản biện cần đăng nhập, đánh giá (GĐ5) và upload phiếu SCI-ACE-PĐG; link Khu vực Hội đồng / Theo dõi tiến trình. |
| **GĐ5 – Kết quả họp Hội đồng** (Chấp thuận / Chấp thuận có điều kiện / Không chấp thuận) | (1) Nghiên cứu viên; (2) Danh sách người nhận | (1) [SCI-ACE] Kết quả họp Hội đồng – Hồ sơ: &lt;tên&gt;; (2) [SCI-ACE] Thư ký đã ghi nhận kết quả họp (GĐ5) – Hồ sơ: &lt;tên&gt; | Kết luận Hội đồng; bước tiếp theo (cấp QĐ / nộp SCI-ACE-04 / kết thúc); link Theo dõi tiến trình / Khu vực Hội đồng. |
| **NCV nộp bản giải trình SCI-ACE-04** (chấp thuận có điều kiện) | Danh sách người nhận | [SCI-ACE] NCV đã nộp bản giải trình SCI-ACE-04 – Hồ sơ: &lt;tên&gt; | NCV đã nộp SCI-ACE-04; Hội đồng/Chủ tịch đăng nhập để tải file và xem xét; link theo dõi. |
| **Chủ tịch chưa thông qua bản giải trình** | (1) Nghiên cứu viên; (2) Danh sách người nhận | (1) [SCI-ACE] Chưa thông qua bản giải trình – Hồ sơ: &lt;tên&gt; | Chủ tịch chưa thông qua; NCV cần nộp lại tài liệu giải trình; link Hội đồng / Hồ sơ của tôi. |
| **Đã cấp Quyết định (SCI-ACE-QĐ)** | (1) Nghiên cứu viên; (2) Danh sách người nhận | [SCI-ACE] Đã cấp Quyết định – Hồ sơ: &lt;tên&gt; | Thông báo đã cấp QĐ (VN + EN); link xem chi tiết và tải Quyết định. |

### B. Đề tài cấp Viện

| Giai đoạn / Sự kiện | Người nhận | Tiêu đề email | Nội dung chính |
|---------------------|------------|----------------|-----------------|
| **Bước 2 – Thư ký yêu cầu bổ sung hồ sơ** | (1) Nghiên cứu viên (email người nộp); (2) Danh sách người nhận | (1) [Đề tài cấp Viện] Yêu cầu bổ sung hồ sơ: &lt;tên&gt;; (2) [Đề tài cấp Viện] Thư ký đã gửi yêu cầu bổ sung (Bước 2) – &lt;tên&gt; | Nội dung yêu cầu bổ sung; NCV cần chỉnh sửa và nộp lại; link Nộp lại hồ sơ / Theo dõi đề tài. Hội đồng nhận bản ghi nhận cùng nội dung. |

### C. Email khác (không theo giai đoạn đề tài)

| Sự kiện | Người nhận | Nội dung |
|---------|------------|----------|
| **Quên mật khẩu** | Email người yêu cầu | Link đặt lại mật khẩu (hiệu lực 1 giờ). |
| **Admin gửi email thông báo cấp vai trò** | Email thành viên được cấp | Thông báo vai trò (Chủ tịch / Thư ký / …) và mật khẩu tạm (nếu Admin chọn gửi). |

---

## 3. Tóm tắt

1. **Để gửi được email:** Cấu hình SMTP trong `.env` (Gmail hoặc SMTP khác), rồi **khởi động lại** `node server.js`.
2. **Ai nhận thông báo:** Quản lý tại **Quản trị → Danh sách người nhận email thông báo** (thêm/xóa email). Mọi thông báo theo giai đoạn đề tài gửi tới danh sách này (và thêm nghiên cứu viên / phản biện khi có từng sự kiện).
3. **Nội dung:** Mỗi email có tiêu đề rõ ràng (tên hồ sơ + sự kiện), nội dung ngắn gọn và link đăng nhập/xem chi tiết; Hội đồng và NCV nhận đúng thông tin theo từng giai đoạn như bảng trên.

Nếu sau khi cấu hình vẫn không gửi được, kiểm tra: (1) `.env` đúng đường dẫn và không lỗi cú pháp; (2) Gmail dùng Mật khẩu ứng dụng; (3) Console khi chạy `node server.js` có báo lỗi SMTP hay không.
