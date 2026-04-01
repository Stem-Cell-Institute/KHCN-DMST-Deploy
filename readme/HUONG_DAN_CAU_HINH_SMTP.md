# Hướng dẫn cấu hình SMTP – Từng bước

Cấu hình này giúp hệ thống **gửi email** (thông báo hồ sơ mới, quên mật khẩu, cấp vai trò). Làm lần đầu một lần là xong.

---

## Bước 1: Chọn email bạn sẽ dùng để gửi

Bạn cần **một tài khoản email** để hệ thống gửi thư thay bạn. Chọn **một** trong hai:

- **A.** Gmail (ví dụ: yourname@gmail.com)  
- **B.** Email cơ quan/trường (ví dụ: sinhnguyen@sci.edu.vn – thường dùng Outlook/Microsoft 365)

Ghi nhớ bạn chọn A hay B, rồi làm tiếp Bước 2.

---

## Bước 2: Tạo file tên `.env` trong thư mục dự án

1. Mở thư mục dự án **"Hội đồng đạo đức AEC SCI"** (nơi có file `server.js`, `package.json`).
2. Trong thư mục đó, tìm file **`.env.example`** (có thể phải bật “Hiện file ẩn” mới thấy).
3. **Sao chép** file `.env.example`:
   - Chuột phải vào `.env.example` → **Sao chép** (Copy).
   - Chuột phải vào khoảng trống trong thư mục → **Dán** (Paste).
4. Đổi tên file vừa dán thành **`.env`** (bỏ phần `.example`, chỉ còn tên `.env`).
   - Trên Windows: chuột phải file → Đổi tên → gõ: `.env`

Hoặc trong Cursor/VS Code:

1. Mở thư mục dự án.
2. Trong thanh bên (Explorer), chuột phải vào **`.env.example`**.
3. Chọn **Copy** rồi **Paste**.
4. Đổi tên file bản sao thành **`.env`**.

Kết quả: trong thư mục có cả `.env.example` và `.env`. Bạn sẽ **chỉ sửa** file `.env`.

---

## Bước 3: Lấy mật khẩu dùng cho “ứng dụng” (nếu bạn chọn Gmail – cách A)

**Chỉ làm bước này nếu bạn dùng Gmail.**

1. Vào: https://myaccount.google.com/apppasswords  
   (Đăng nhập Gmail nếu được hỏi.)
2. Nếu Google báo “Tính năng này không khả dụng”:
   - Vào https://myaccount.google.com/security  
   - Bật **Xác minh 2 bước** (2-Step Verification) trước.
   - Sau đó quay lại bước 1 (apppasswords).
3. Trong trang “Mật khẩu ứng dụng”:
   - Ở “Chọn ứng dụng”: chọn **Thư** (Mail).
   - Ở “Chọn thiết bị”: chọn **Máy tính Windows** (hoặc khác cũng được).
   - Nhấn **Tạo**.
4. Google hiện **mật khẩu 16 ký tự** (dạng `xxxx xxxx xxxx xxxx`).  
   → **Copy** mật khẩu đó và **lưu tạm** (Notepad). Bạn sẽ dán vào file `.env` ở Bước 5.  
   (Bạn có thể bỏ dấu cách, dùng luôn `xxxxxxxxxxxxxxxx`.)

Nếu bạn **không** dùng Gmail thì bỏ qua Bước 3, làm tiếp Bước 4.

---

## Bước 4: Mở file `.env` để sửa

1. Trong thư mục dự án, mở file **`.env`** bằng Cursor (hoặc Notepad, Notepad++).
2. File `.env` là file văn bản, có nhiều dòng dạng `TÊN=giá trị`. Bạn sẽ thay **giá trị** cho đúng với email của bạn.

---

## Bước 5: Điền thông tin vào file `.env`

Chọn **đúng một** trong hai khung dưới, rồi **thay** các chỗ in nghiêng bằng thông tin thật của bạn. **Không** thay đổi các dòng như `SMTP_HOST=`, `SMTP_PORT=`, v.v., chỉ thay phần bên phải dấu `=`.

### Nếu bạn dùng Gmail (cách A)

Trong file `.env`, sửa cho giống như sau (thay *email-cua-ban@gmail.com* và *mat-khau-ung-dung-16-ky-tu*):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=email-cua-ban@gmail.com
SMTP_PASS=mat-khau-ung-dung-16-ky-tu
SMTP_FROM=email-cua-ban@gmail.com

BASE_URL=http://localhost:3000
JWT_SECRET=your-secret-key
```

- **SMTP_USER** và **SMTP_FROM**: thay bằng địa chỉ Gmail của bạn (ví dụ: `nguyenvana@gmail.com`).
- **SMTP_PASS**: thay bằng mật khẩu ứng dụng 16 ký tự bạn đã tạo ở Bước 3 (có thể dán không dấu cách).

### Nếu bạn dùng email cơ quan @sci.edu.vn (cách B – Outlook / Office 365)

Trong file `.env`, sửa cho giống như sau (thay *email và mật khẩu đăng nhập Outlook* của bạn):

```
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=sinhnguyen@sci.edu.vn
SMTP_PASS=mat-khau-dang-nhap-email-cua-ban
SMTP_FROM=sinhnguyen@sci.edu.vn

BASE_URL=http://localhost:3000
JWT_SECRET=your-secret-key
```

- **SMTP_USER** và **SMTP_FROM**: thay bằng email cơ quan của bạn (ví dụ: `sinhnguyen@sci.edu.vn`).
- **SMTP_PASS**: thay bằng **mật khẩu đăng nhập** vào Outlook/email cơ quan (mật khẩu bạn dùng để vào webmail hoặc Outlook).

Sau khi sửa xong: **Lưu** file `.env** (Ctrl + S).

---

## Bước 6: Khởi động lại server

1. Nếu đang chạy server (terminal có `npm start`), nhấn **Ctrl + C** để tắt.
2. Chạy lại: gõ `npm start` rồi Enter.
3. Khi server chạy, thử một chức năng gửi email (ví dụ: Quên mật khẩu, hoặc Gửi email thông báo cấp vai trò). Nếu cấu hình đúng, email sẽ được gửi.

---

## Lưu ý

- File **`.env`** chứa mật khẩu, **không** đưa lên mạng (không commit lên Git). Dự án đã có cấu hình để bỏ qua `.env` khi đẩy code.
- Nếu dùng email cơ quan (@sci.edu.vn) mà gửi **lỗi** (ví dụ “Authentication failed”), có thể đơn vị tắt gửi qua SMTP. Khi đó cần liên hệ bộ phận IT trường/cơ quan để xác nhận có được dùng SMTP (smtp.office365.com, cổng 587) không.
- **BASE_URL**: nếu bạn chạy web trên máy mình cho người khác dùng, có thể đổi thành địa chỉ thật (ví dụ `https://sci-ace.science.edu.vn`). Với thử nghiệm trên máy local, để `http://localhost:3000` là được.

Nếu làm đủ 6 bước mà vẫn không gửi được email, gửi lại cho tôi (hoặc người hỗ trợ) nội dung **lỗi** hiện trên màn hình (bỏ qua mật khẩu), để kiểm tra tiếp.
