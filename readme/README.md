# 📦 TÀI LIỆU QUY TRÌNH UPLOAD HỒ SƠ - HỆ THỐNG SCI-ACE

## 🎯 Mục đích

Bộ tài liệu này cung cấp hướng dẫn chi tiết về quy trình upload hồ sơ trong hệ thống SCI-ACE, giúp các vai trò khác nhau (Nghiên cứu viên, Thư ký, Thành viên Hội đồng, Chủ tịch/Admin) hiểu rõ trách nhiệm và cách thức thực hiện công việc của mình.

---

## 📁 Danh sách tài liệu

### 1️⃣ **QUY_TRINH_UPLOAD_HO_SO.md** (28 KB)
📖 **Mô tả:** Tài liệu chi tiết nhất về quy trình 8 giai đoạn

**Nội dung:**
- 4 vai trò trong hệ thống (Nghiên cứu viên, Thư ký, Thành viên HĐ, Chủ tịch)
- 8 giai đoạn chi tiết với từng bước upload
- Dashboard mẫu cho Admin/Hội đồng
- Bảng tổng hợp hồ sơ theo giai đoạn
- Hệ thống cảnh báo và nhắc nhở
- Báo cáo thống kê
- Email tự động
- Checklist theo vai trò

**Phù hợp cho:**
- ✅ Admin/Chủ tịch muốn hiểu tổng thể quy trình
- ✅ Thư ký cần biết cách theo dõi tiến độ
- ✅ Developer cần spec để lập trình

**Đọc đầu tiên nếu bạn muốn:** Hiểu rõ toàn bộ quy trình từ A-Z

---

### 2️⃣ **SO_DO_QUY_TRINH.md** (8.8 KB)
🎨 **Mô tả:** Sơ đồ trực quan bằng Mermaid

**Nội dung:**
- Sơ đồ tổng quan quy trình (Flowchart)
- Sơ đồ vai trò và trách nhiệm
- Sơ đồ trạng thái hồ sơ (State Diagram)
- Timeline quy trình (Gantt Chart)
- Sơ đồ checklist theo giai đoạn
- Ma trận trách nhiệm RACI

**Phù hợp cho:**
- ✅ Người thích học qua hình ảnh
- ✅ Trình bày trong meeting
- ✅ Tài liệu training

**Cách sử dụng:**
1. Copy đoạn code Mermaid
2. Paste vào https://mermaid.live
3. Xem sơ đồ trực quan
4. Export thành PNG/SVG

**Đọc đầu tiên nếu bạn muốn:** Xem quy trình một cách trực quan, dễ hiểu

---

### 3️⃣ **HUONG_DAN_TRIEN_KHAI.md** (28 KB)
💻 **Mô tả:** Hướng dẫn kỹ thuật triển khai vào website

**Nội dung:**
- Cấu trúc Database (6 tables)
- API Endpoints cần thiết
- Giao diện Dashboard (HTML + JS)
- Hệ thống Email tự động
- Cron Jobs để nhắc nhở
- Dashboard Widgets
- Phân quyền truy cập
- Hướng dẫn deploy

**Phù hợp cho:**
- ✅ Developer backend/frontend
- ✅ Database Admin
- ✅ DevOps Engineer

**Đọc đầu tiên nếu bạn muốn:** Code và triển khai hệ thống

---

### 4️⃣ **Tracking_Ho_So_SCI-ACE.xlsx** (9.9 KB)
📊 **Mô tả:** File Excel theo dõi tiến trình

**Nội dung:**
- **Sheet 1: Theo dõi hồ sơ** - Template tracking với dữ liệu mẫu
- **Sheet 2: Dashboard** - Thống kê tổng quan
- **Sheet 3: Checklist vai trò** - Checklist cho từng vai trò
- **Sheet 4: Danh mục tài liệu** - Bảng tổng hợp tài liệu theo giai đoạn

**Phù hợp cho:**
- ✅ Thư ký Hội đồng theo dõi hằng ngày
- ✅ Admin muốn có báo cáo nhanh
- ✅ Sử dụng ngay mà không cần code

**Cách sử dụng:**
1. Mở file Excel
2. Vào Sheet "Theo dõi hồ sơ"
3. Thêm hồ sơ mới vào dòng tiếp theo
4. Đánh dấu ✓ vào các giai đoạn đã hoàn thành
5. Cập nhật trạng thái và hạn xử lý

**Đọc đầu tiên nếu bạn muốn:** Bắt đầu theo dõi ngay lập tức bằng Excel

---

## 🚀 Hướng dẫn sử dụng nhanh

### Dành cho **Admin/Chủ tịch:**
1. 📖 Đọc `QUY_TRINH_UPLOAD_HO_SO.md` - Phần "Quy trình 8 giai đoạn"
2. 🎨 Xem `SO_DO_QUY_TRINH.md` - Sơ đồ tổng quan
3. 📊 Sử dụng `Tracking_Ho_So_SCI-ACE.xlsx` để theo dõi

### Dành cho **Thư ký:**
1. 📊 Mở `Tracking_Ho_So_SCI-ACE.xlsx` - Sheet "Theo dõi hồ sơ"
2. 📖 Đọc `QUY_TRINH_UPLOAD_HO_SO.md` - Phần "Checklist Thư ký"
3. 💻 Tham khảo `HUONG_DAN_TRIEN_KHAI.md` - Phần "Hệ thống Email tự động"

### Dành cho **Nghiên cứu viên:**
1. 🎨 Xem `SO_DO_QUY_TRINH.md` - Sơ đồ tổng quan để hiểu quy trình
2. 📖 Đọc `QUY_TRINH_UPLOAD_HO_SO.md` - Giai đoạn 1, 2, 8
3. 📊 Tham khảo `Tracking_Ho_So_SCI-ACE.xlsx` - Sheet "Danh mục tài liệu"

### Dành cho **Developer:**
1. 📖 Đọc `QUY_TRINH_UPLOAD_HO_SO.md` - Hiểu business logic
2. 💻 Implement theo `HUONG_DAN_TRIEN_KHAI.md`
3. 🎨 Sử dụng `SO_DO_QUY_TRINH.md` để tạo tài liệu kỹ thuật

---

## 📋 Checklist tổng hợp

### ✅ Đã cung cấp:
- [x] Tài liệu chi tiết 8 giai đoạn
- [x] Sơ đồ quy trình (Mermaid)
- [x] Hướng dẫn triển khai kỹ thuật
- [x] File Excel tracking
- [x] Dashboard mockup
- [x] Email templates
- [x] Database schema
- [x] API endpoints
- [x] Phân quyền chi tiết
- [x] Ma trận RACI

### 📌 Thông tin quan trọng:

**Thời gian xử lý trung bình:** 18-25 ngày  
**Số giai đoạn:** 8  
**Số vai trò:** 4 (Nghiên cứu viên, Thư ký, Thành viên HĐ, Chủ tịch)  
**Số loại tài liệu:** 10 (SCI-ACE-01 đến 07, PĐG, 05, QĐ)

---

## 🎓 Câu hỏi thường gặp

**Q: Tôi nên bắt đầu từ đâu?**  
A: Tùy vai trò:
- Admin → Đọc `QUY_TRINH_UPLOAD_HO_SO.md`
- Thư ký → Dùng `Tracking_Ho_So_SCI-ACE.xlsx`
- Developer → Đọc `HUONG_DAN_TRIEN_KHAI.md`
- Muốn xem nhanh → Xem `SO_DO_QUY_TRINH.md`

**Q: File nào có code mẫu?**  
A: `HUONG_DAN_TRIEN_KHAI.md` có code mẫu cho:
- Database schema (SQL)
- API endpoints (JavaScript)
- Dashboard UI (HTML/CSS/JS)
- Email service (JavaScript)
- Cron jobs (JavaScript)

**Q: Làm sao để xem sơ đồ Mermaid?**  
A: 
1. Mở `SO_DO_QUY_TRINH.md`
2. Copy đoạn code trong ``` mermaid ```
3. Paste vào https://mermaid.live
4. Xem và export

**Q: File Excel có thể chỉnh sửa được không?**  
A: Có, bạn có thể:
- Thêm/xóa hồ sơ
- Tùy chỉnh màu sắc
- Thêm cột mới
- Tạo biểu đồ riêng

---

## 💡 Tips sử dụng hiệu quả

1. **In ra giấy:** `QUY_TRINH_UPLOAD_HO_SO.md` phần "Bảng tổng hợp" để dán lên tường
2. **Meeting:** Dùng sơ đồ trong `SO_DO_QUY_TRINH.md` để trình bày
3. **Daily tracking:** Mở `Tracking_Ho_So_SCI-ACE.xlsx` mỗi sáng để cập nhật
4. **Onboarding:** Cho nhân viên mới đọc `QUY_TRINH_UPLOAD_HO_SO.md` từ đầu đến cuối

---

## 🔄 Cập nhật và phản hồi

Nếu có góp ý hoặc cần bổ sung, vui lòng liên hệ:
- Email: [Thư ký Hội đồng]
- Hoặc tạo issue trong hệ thống quản lý dự án

---

## 📎 Tài liệu liên quan

- Website hiện tại: Xem các file HTML trong thư mục uploads
- Quy chế Hội đồng: `NHOM_1_2_Quy_che_to_chuc_va_hoat_dong_HDDD.docx`
- Hướng dẫn 3R: `NHOM_1_1_Huong_dan_van_tat_thao_tac_dong_vat.docx`

---

## ✨ Tóm tắt nhanh

| Tài liệu | Dung lượng | Đọc trong | Phù hợp cho |
|----------|-----------|-----------|-------------|
| QUY_TRINH_UPLOAD_HO_SO.md | 28 KB | 15-20 phút | Admin, Thư ký, Toàn bộ |
| SO_DO_QUY_TRINH.md | 8.8 KB | 5-10 phút | Visual learner, Training |
| HUONG_DAN_TRIEN_KHAI.md | 28 KB | 20-30 phút | Developer, Tech team |
| Tracking_Ho_So_SCI-ACE.xlsx | 9.9 KB | 2-5 phút | Thư ký, Daily use |

---

**Phiên bản:** 1.0  
**Ngày tạo:** 03/02/2026  
**Tạo bởi:** Claude AI Assistant  
**Mục đích:** Hỗ trợ triển khai hệ thống tracking cho SCI-ACE

---

🎉 **Chúc bạn triển khai thành công!**
