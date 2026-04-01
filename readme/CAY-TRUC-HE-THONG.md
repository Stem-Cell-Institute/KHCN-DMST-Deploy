# CẤU TRÚC HỆ THỐNG SCI-ACE

## 📊 TỔNG QUAN HỆ THỐNG

Dữ liệu SQLite dùng **một file** `sci-ace.db` (gom cả Đề tài cấp Viện). Nếu còn file cũ `de-tai-cap-vien.db`, lần khởi động đầu tiên server sẽ tự copy dữ liệu sang `sci-ace.db` và đổi tên file cũ thành `*.migrated.*.bak`.

### 🗄️ Database: SCI-ACE (`sci-ace.db`)
- **Chức năng**: Quản lý hồ sơ SCI-ACE **và** các bảng `cap_vien_*` (Đề tài cấp Viện)
- **Users**: Quản lý người dùng chung
- **Tables chính**:
  - `users` - Người dùng
  - `submissions` - Hồ sơ SCI-ACE
  - `submission_files` - Files của hồ sơ SCI-ACE
  - `submission_gd5_history` - Lịch sử GD5
  - `missions` - Nhiệm vụ
  - `password_reset_tokens` - Reset password
  - `notification_recipients` - Email notifications
  - `homepage_modules` - Modules trang chủ
  - `system_settings` - Cấu hình hệ thống

### 🏛️ Đề tài cấp Viện (cùng `sci-ace.db`)
- **Chức năng**: Quản lý đề tài cấp viện
- **Tables chính** (prefix `cap_vien_`):
  - `cap_vien_submissions` - Hồ sơ đề tài cấp viện
  - `cap_vien_submission_files` - Files của đề tài cấp viện
  - `cap_vien_step2_history` - Lịch sử bước 2
  - `cap_vien_submission_history` - Lịch sử chung
  - `cap_vien_submission_options` - Options đánh dấu
  - `cap_vien_linh_vuc` - Lĩnh vực
  - `cap_vien_loai_de_tai` - Loại đề tài
  - `cap_vien_don_vi` - Đơn vị
  - `cap_vien_khoan_muc_chi` - Khoản mục chi

## 🔄 LUỒNG DỊCH VỤ

### Users chung
- Table `users` nằm trong `sci-ace.db`; module Đề tài cấp Viện dùng chung
- Login/Authentication chỉ dùng `sci-ace.db`

### Files upload
- **SCI-ACE**: Upload vào `uploads/`
- **Đề tài cấp viện**: Upload vào `uploads-cap-vien/`

### Routes chính
- `/api/*` - SCI-ACE routes
- `/api/cap-vien/*` - Đề tài cấp viện routes
- `/api/admin/*` - Admin routes (cho cả 2 hệ thống)

## 📋 QUY TRÌNH HOẠT ĐỘNG

### SCI-ACE Workflow
1. **Nộp hồ sơ** → SUBMITTED
2. **Thư ký kiểm tra** → VALIDATED/NEED_REVISION
3. **Chủ tịch phân công** → ASSIGNED
4. **Phản biện đánh giá** → UNDER_REVIEW
5. **Hội đồng họp** → IN_MEETING
6. **Ra quyết định** → APPROVED/CONDITIONAL/REJECTED
7. **Triển khai** → IMPLEMENTATION
8. **Báo cáo** → COMPLETED

### Đề tài cấp Viện Workflow
1. **Nộp hồ sơ** → SUBMITTED
2. **Thư ký kiểm tra** → VALIDATED/NEED_REVISION
3. **Chủ tịch phân công phản biện** → ASSIGNED
4. **Phản biện đánh giá** → UNDER_REVIEW
5. **Tổ thẩm định tài chính** → BUDGET_APPROVED
6. **Hội đồng họp** → REVIEWED
7. **Cấp quyết định** → APPROVED

## 🔗 KẾT NỐI

- **Port mặc định**: 3000
- **Health check**: `/api/health`
- **Database location**: `data/`
- **Upload folders**: `uploads/` và `uploads-cap-vien/`

## 🚀 CÁCH CHẠY HỆ THỐNG

1. **Start server**: `npm start` hoặc `node server.js`
2. **Truy cập**: http://localhost:3000
3. **Login**: Dùng email @sci.edu.vn
4. **Admin default**: sinhnguyen@sci.edu.vn

---
*Document này mô tả cấu trúc hiện tại của hệ thống SCI-ACE*
