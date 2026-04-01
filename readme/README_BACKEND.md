# Hướng dẫn chạy backend SCI-ACE

## Chức năng

- **Đăng ký**: Chỉ email đuôi `@sci.edu.vn` được phép đăng ký.
- **Đăng nhập**: Nghiên cứu viên / Thành viên Hội đồng / Admin đăng nhập bằng email và mật khẩu.
- **Nộp hồ sơ**: Nghiên cứu viên đăng nhập → vào trang **Nộp hồ sơ** → điền tên đề tài và tải lên đúng từng đầu mục:
  - **SCI-ACE-01** (Đơn đề nghị xét duyệt) — bắt buộc
  - **SCI-ACE-02** (Phiếu thuyết minh đề tài) — bắt buộc
  - **SCI-ACE-03** (Báo cáo tuân thủ 3R) — bắt buộc
  - Tài liệu đính kèm (tùy chọn, nhiều file).
- **Thông báo email**: Sau khi nghiên cứu viên nộp hồ sơ, hệ thống gửi email đến tất cả thành viên Hội đồng (Chủ tịch, Thư ký, Thành viên).
- **Hội đồng**: Thành viên Hội đồng đăng nhập → vào **Khu vực Hội đồng** → xem danh sách hồ sơ đã nộp và **tải hồ sơ** (zip hoặc file đơn).
- **Admin**: Chỉ tài khoản **sinhnguyen@sci.edu.vn** là Admin. Admin vào **Quản trị** để cấp quyền: **Chủ tịch**, **Thư ký**, **Thành viên Hội đồng** cho các tài khoản @sci.edu.vn khác.

### Phương thức cấp vai trò cho thành viên Hội đồng

1. **Ai được cấp quyền:** Chỉ tài khoản Admin **sinhnguyen@sci.edu.vn** có quyền cấp vai trò.
2. **Vai trò có thể gán:** Nghiên cứu viên, Thành viên Hội đồng, Thư ký, Chủ tịch.
3. **Ràng buộc:** Chỉ tài khoản có đuôi **@sci.edu.vn** mới được gán vai trò Chủ tịch, Thư ký hoặc Thành viên Hội đồng; tài khoản khác chỉ có thể là Nghiên cứu viên.
4. **Cách làm:** Đăng nhập Admin → vào trang **Quản trị** → trong bảng "Danh sách tài khoản và vai trò", chọn vai trò từ dropdown và nhấn **Lưu**. Tài khoản Admin không thể đổi vai trò của chính mình từ trang này.

## Cài đặt và chạy

1. **Cài Node.js** (phiên bản 18 trở lên).

2. **Cài dependency** (trong thư mục gốc dự án):
   ```bash
   npm install
   ```

3. **Chạy server**:
   ```bash
   npm start
   ```
   Server chạy tại: **http://localhost:3000**

4. **Truy cập trang web**: Mở trình duyệt và vào **http://localhost:3000** (hoặc http://localhost:3000/index.html).  
   - Đăng ký: http://localhost:3000/dang-ky.html  
   - Đăng nhập: http://localhost:3000/dang-nhap.html  
   - Nộp hồ sơ: http://localhost:3000/nop-ho-so.html (cần đăng nhập)  
   - Khu vực Hội đồng: http://localhost:3000/hoi-dong.html (cần đăng nhập với vai trò Hội đồng)  
   - Quản trị: http://localhost:3000/quan-tri.html (chỉ Admin sinhnguyen@sci.edu.vn)

## Tài khoản Admin mặc định

- **Email**: `sinhnguyen@sci.edu.vn`  
- **Mật khẩu**: `admin123`  

Lần đầu chạy server sẽ tự tạo tài khoản này nếu chưa có. **Nên đổi mật khẩu ngay sau lần đăng nhập đầu.**

## Quên mật khẩu

- Thành viên (nghiên cứu viên, Hội đồng, Admin) có thể dùng **Quên mật khẩu** từ trang đăng nhập.
- Trên trang **Quên mật khẩu** nhập email → hệ thống gửi link đặt lại mật khẩu qua email (link có hiệu lực **1 giờ**).
- Nhấn link trong email → trang **Đặt lại mật khẩu** → nhập mật khẩu mới và xác nhận → đăng nhập lại bằng mật khẩu mới.
- **Lưu ý:** Chức năng quên mật khẩu cần cấu hình SMTP (xem bên dưới). Nếu chưa cấu hình, link đặt lại sẽ không được gửi qua email.

## Cấu hình email (SMTP)

Để gửi email thông báo (Hội đồng khi có hồ sơ mới, **quên mật khẩu**, **thông báo cấp vai trò**), cần cấu hình SMTP qua file **`.env`**.

### Bước 1: Tạo file `.env`

Trong thư mục gốc dự án (cùng cấp với `server.js`), tạo file tên **`.env`**:

- **Cách nhanh:** Sao chép từ file mẫu:
  - Windows (PowerShell): `Copy-Item .env.example .env`
  - Hoặc sao chép nội dung từ `.env.example` vào file mới đặt tên `.env`

### Bước 2: Điền thông tin SMTP vào `.env`

Chọn **một** trong hai cách dưới đây (hoặc nhà cung cấp email khác nếu bạn biết SMTP của họ).

#### Cách A: Gmail

1. Bật [Xác minh 2 bước](https://myaccount.google.com/signinoptions/two-step-verification) cho tài khoản Google.
2. Tạo [Mật khẩu ứng dụng](https://myaccount.google.com/apppasswords) (App Password) — **không dùng** mật khẩu đăng nhập thường.
3. Trong `.env` điền:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=xxxx-xxxx-xxxx-xxxx
SMTP_FROM=your-email@gmail.com
BASE_URL=http://localhost:3000
JWT_SECRET=your-secret-key
```

Thay `your-email@gmail.com` và `xxxx-xxxx-xxxx-xxxx` bằng email Gmail và mật khẩu ứng dụng của bạn.

#### Cách B: Office 365 / Outlook (email cơ quan, ví dụ @sci.edu.vn)

Nếu trường/cơ quan dùng Microsoft 365 (Outlook), thường dùng SMTP sau:

```env
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=sinhnguyen@sci.edu.vn
SMTP_PASS=mat-khau-email-cua-ban
SMTP_FROM=sinhnguyen@sci.edu.vn
BASE_URL=http://localhost:3000
JWT_SECRET=your-secret-key
```

- Thay `sinhnguyen@sci.edu.vn` và `mat-khau-email-cua-ban` bằng email và mật khẩu đăng nhập Outlook của bạn.
- Một số tổ chức tắt SMTP hoặc bắt buộc xác thực 2 bước; nếu gửi lỗi, liên hệ bộ phận IT để xác nhận SMTP (smtp.office365.com, port 587) và quy định bảo mật.

### Biến môi trường SMTP

| Biến | Bắt buộc | Mô tả |
|------|----------|--------|
| `SMTP_HOST` | Có | Máy chủ SMTP (vd: smtp.gmail.com, smtp.office365.com) |
| `SMTP_USER` | Có | Email đăng nhập SMTP |
| `SMTP_PASS` | Có | Mật khẩu (Gmail: dùng App Password) |
| `SMTP_PORT` | Không | Mặc định 587 |
| `SMTP_SECURE` | Không | `true` nếu dùng port 465, thường để `false` với 587 |
| `SMTP_FROM` | Không | Địa chỉ "Người gửi" trong email; nếu bỏ trống thì dùng `SMTP_USER` |
| `BASE_URL` | Không | URL gốc trang web (để tạo link trong email); mặc định http://localhost:3000 |

### Bước 3: Khởi động lại server

Sau khi sửa `.env`, chạy lại:

```bash
npm start
```

- Nếu cấu hình đúng, khi có hồ sơ mới / quên mật khẩu / gửi email cấp vai trò, hệ thống sẽ gửi email.
- Nếu **không** tạo hoặc không điền đủ `SMTP_HOST` và `SMTP_USER`, server vẫn chạy bình thường nhưng **sẽ không gửi email**; hồ sơ vẫn lưu và Hội đồng vẫn xem/tải được.

## Cấu hình khác

- **Cổng (port)**: Mặc định `3000`. Đổi bằng biến môi trường: `PORT=8080 npm start` hoặc thêm vào `.env`: `PORT=8080`.

## Dữ liệu

- **SQLite**: Database và file tải lên nằm trong thư mục:
  - `data/sci-ace.db` — cơ sở dữ liệu
  - `uploads/<Họ tên NCV>_<userId>/submission_<id>/` — hồ sơ được phân loại theo từng nghiên cứu viên (thư mục con là họ tên đã chuẩn hóa + mã user), bên trong mỗi đợt nộp có thư mục `submission_<id>` chứa file

Để reset hoàn toàn: xóa thư mục `data/` và `uploads/` rồi chạy lại `npm start` (Admin mặc định sẽ được tạo lại).
