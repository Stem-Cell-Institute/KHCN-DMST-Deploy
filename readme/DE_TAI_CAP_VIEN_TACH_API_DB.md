# Đề xuất: Tách API và CSDL riêng cho Đề tài cấp Viện (Nhiệm vụ KHCN cấp cơ sở)

## Khuyến nghị: **Nên tách**

Nên tách API và CSDL (hoặc ít nhất **bảng/namespace riêng**) cho luồng **Đề tài cấp Viện** so với luồng **Hội đồng đạo đức (SCI-ACE)** vì:

1. **Quy trình khác nhau**  
   Bạn dự kiến tùy chỉnh giai đoạn và cách thức theo dõi đề tài cấp Viện (đăng ký → xét chọn → phê duyệt → nghiệm thu, báo cáo tiến độ, v.v.) khác với quy trình ACE (SCI-ACE-01/02/03 → phản biện → họp Hội đồng → QĐ, 3R, v.v.). Một CSDL/API chung sẽ phải chứa nhiều trường và trạng thái “dùng cho ACE” hoặc “dùng cho cấp Viện” → dễ rối, khó mở rộng.

2. **Trạng thái và giai đoạn riêng**  
   Đề tài cấp Viện có thể có: Lập kế hoạch → Nộp hồ sơ → Thẩm định → Phê duyệt → Đang thực hiện → Báo cáo tiến độ → Nghiệm thu → Hoàn thành (và có thể thêm/bớt bước). ACE có vòng đời khác (SUBMITTED → ASSIGNED → … → QĐ). Dùng chung một bảng `submissions` với cột “type” và nhiều cột nullable sẽ khó bảo trì và truy vấn.

3. **Tài liệu đính kèm khác**  
   ACE: SCI-ACE-01, 02, 03, v.v. Đề tài cấp Viện: Thuyết minh, Kế hoạch, báo cáo tiến độ, v.v. Cấu trúc file và danh sách trường upload khác nhau → tách bảng/file riêng sẽ rõ ràng hơn.

4. **Phân quyền và báo cáo**  
   Sau này có thể cần phân quyền (Hội đồng cấp Viện vs Hội đồng ACE), báo cáo thống kê riêng cho từng luồng. Tách sớm giúp truy vấn và bảo mật đơn giản hơn.

---

## Hai hướng triển khai

### Cách 1: Tách hoàn toàn (khuyến nghị khi đã ổn định nhu cầu)

- **CSDL:**  
  - Giữ `data/sci-ace.db` cho ACE.  
  - Tạo DB mới, ví dụ `data/de-tai-cap-vien.db` (hoặc schema riêng nếu dùng PostgreSQL), với bảng riêng, ví dụ:  
    - `de_tai_cap_vien` (thông tin đề tài, trạng thái, giai đoạn, ngày nộp, người nộp, …)  
    - `de_tai_cap_vien_files` (file đính kèm: thuyết minh, kế hoạch, báo cáo, …)  
    - `de_tai_cap_vien_tien_do` (bảng theo dõi tiến độ / giai đoạn tùy chỉnh của bạn).

- **API:**  
  - Tiền tố riêng, ví dụ `/api/cap-vien/...`:  
    - `POST /api/cap-vien/submissions` — nộp đề tài  
    - `GET /api/cap-vien/submissions` — danh sách (Hội đồng / của tôi)  
    - `GET /api/cap-vien/submissions/:id` — chi tiết + tiến độ  
    - `GET /api/cap-vien/submissions/:id/download` — tải file  
    - Các endpoint bổ sung: cập nhật giai đoạn, trạng thái, phân công, v.v.

- **Frontend:**  
  - Các trang `nop-de-tai-cap-vien.html`, `theo-doi-de-tai-cap-vien.html`, `hoi-dong-de-tai-cap-vien.html` gọi API `/api/cap-vien/...` thay vì `/api/submissions`.  
  - Trang “Tiến trình” có thể dùng một URL riêng (ví dụ `theo-doi-de-tai-cap-vien-chi-tiet.html?id=...`) và hiển thị các giai đoạn theo quy định cấp Viện.

### Cách 2: Tách dần (ít thay đổi backend ngay)

- **CSDL:**  
  - Vẫn dùng một DB, nhưng thêm bảng riêng cho cấp Viện, ví dụ `de_tai_cap_vien`, `de_tai_cap_vien_files`.  
  - Không dùng bảng `submissions` chung cho đề tài cấp Viện nữa (tránh lẫn với ACE).

- **API:**  
  - Thêm nhóm route `/api/cap-vien/...` như trên, đọc/ghi bảng `de_tai_cap_vien` (và bảng file).  
  - Giữ nguyên `/api/submissions` chỉ cho ACE.

- **Frontend:**  
  - Chuyển dần các trang cấp Viện sang gọi `/api/cap-vien/...`, bỏ lọc theo tiền tố `[Cấp Viện]`.

---

## Kết luận

- **Nên tách** API và CSDL (hoặc ít nhất bảng/route riêng) cho Đề tài cấp Viện để sau này tùy chỉnh giai đoạn và cách thức theo dõi khác với Hội đồng ACE mà không ảnh hưởng lẫn nhau.  
- **Ưu tiên:** Có thể bắt đầu bằng Cách 2 (thêm bảng + `/api/cap-vien/...` trong cùng server/DB), sau đó nếu cần có thể chuyển sang DB riêng (Cách 1).

Nếu bạn muốn, bước tiếp theo có thể là: thiết kế chi tiết bảng `de_tai_cap_vien` (các cột, trạng thái, giai đoạn) và danh sách endpoint `/api/cap-vien/...` tương ứng với quy trình bạn mong muốn.
