# QUY TRÌNH UPLOAD HỒ SƠ CHI TIẾT - HỆ THỐNG SCI-ACE

## 📋 TỔNG QUAN QUY TRÌNH

Hệ thống SCI-ACE quản lý quy trình xét duyệt đạo đức nghiên cứu trên động vật qua **8 GIAI ĐOẠN** chính với **4 VAI TRÒ** tham gia.

---

## 👥 CÁC VAI TRÒ TRONG HỆ THỐNG

### 1. **Nghiên cứu viên (Researcher)** 
- Người nộp hồ sơ đề nghị xét duyệt
- Thực hiện nghiên cứu sau khi được phê duyệt
- Email: `@sci.edu.vn`

### 2. **Thư ký Hội đồng (Secretary)**
- Tiếp nhận và kiểm tra hồ sơ
- Điều phối quy trình
- Gửi thông báo

### 3. **Thành viên Hội đồng (Council Member)**
- Đánh giá và phản biện hồ sơ
- Tham gia họp thẩm định

### 4. **Chủ tịch Hội đồng / Admin**
- Phân công phản biện
- Quyết định cuối cùng
- Ký Quyết định phê duyệt

---

## 🔄 QUY TRÌNH 8 GIAI ĐOẠN

### **GIAI ĐOẠN 1: CHUẨN BỊ HỒ SƠ**
**Người thực hiện:** Nghiên cứu viên  
**Thời gian:** Không giới hạn

#### Hồ sơ cần upload:
| Mã tài liệu | Tên tài liệu | Bắt buộc | Ghi chú |
|------------|--------------|----------|---------|
| SCI-ACE-01 | Đơn đề nghị xét duyệt | ✅ Có | Lần đầu nộp |
| SCI-ACE-02 | Phiếu thuyết minh đề tài | ✅ Có | Lần đầu nộp |
| SCI-ACE-03 | Báo cáo tuân thủ 3R | ✅ Có | Lần đầu nộp |
| Attachments | Tài liệu đính kèm | ⚠️ Nên có | Thuyết minh đề tài, CV, quyết định người hướng dẫn, v.v. |

#### Trạng thái hồ sơ: `DRAFT` (Nháp)

---

### **GIAI ĐOẠN 2: NỘP HỒ SƠ**
**Người thực hiện:** Nghiên cứu viên  
**Thời gian:** Khi hoàn tất chuẩn bị

#### Hành động:
- Nhấn nút "Gửi hồ sơ" trên hệ thống
- Hệ thống tự động:
  - Gửi email thông báo đến Thư ký
  - Gửi email xác nhận đến Nghiên cứu viên

#### Trạng thái hồ sơ: `SUBMITTED` (Đã nộp)

#### Dashboard Admin/Hội đồng hiển thị:
```
✅ Giai đoạn 1-2: Hoàn thành
   • SCI-ACE-01: ✓ Đã có
   • SCI-ACE-02: ✓ Đã có  
   • SCI-ACE-03: ✓ Đã có
   • Tài liệu đính kèm: ✓ Đã có (3 files)
   • Ngày nộp: 03/02/2026
   
⏳ Chờ Thư ký kiểm tra
```

---

### **GIAI ĐOẠN 3: KIỂM TRA HỒ SƠ**
**Người thực hiện:** Thư ký Hội đồng  
**Thời gian:** 3 ngày làm việc

#### Nhiệm vụ:
- Kiểm tra tính đầy đủ của hồ sơ
- Kiểm tra định dạng tài liệu
- Kiểm tra thông tin cơ bản

#### Hai kết quả có thể:

**A. Hồ sơ HỢP LỆ:**
- Thư ký đánh dấu: `VALIDATED` (Đã kiểm tra)
- Chuyển sang Giai đoạn 4

**B. Hồ sơ KHÔNG HỢP LỆ / THIẾU:**
- Thư ký đánh dấu: `NEED_REVISION` (Cần bổ sung)
- Gửi thông báo yêu cầu Nghiên cứu viên bổ sung
- Quay lại Giai đoạn 1

#### Dashboard hiển thị (nếu hợp lệ):
```
✅ Giai đoạn 1-3: Hoàn thành
   • Ngày kiểm tra: 06/02/2026
   • Người kiểm tra: Thư ký Nguyễn Văn A
   • Kết quả: HỢP LỆ
   
⏳ Chờ Chủ tịch phân công phản biện
```

#### Dashboard hiển thị (nếu cần bổ sung):
```
✅ Giai đoạn 1-2: Hoàn thành
⚠️ Giai đoạn 3: CẦN BỔ SUNG
   • Ngày kiểm tra: 06/02/2026
   • Lý do:
     - Thiếu quyết định người hướng dẫn
     - SCI-ACE-02 chưa điền mục 3.2
   
📝 Nghiên cứu viên cần upload thêm:
   • File: Quyết định người hướng dẫn
   • Chỉnh sửa: SCI-ACE-02
```

---

### **GIAI ĐOẠN 4: PHÂN CÔNG PHẢN BIỆN**
**Người thực hiện:** Chủ tịch Hội đồng  
**Thời gian:** 2 ngày làm việc

#### Nhiệm vụ:
- Phân công ít nhất 2 thành viên phản biện
- Gửi hồ sơ cho các thành viên được phân công
- Đặt thời hạn hoàn thành đánh giá (thường 7 ngày)

#### Trạng thái hồ sơ: `UNDER_REVIEW` (Đang đánh giá)

#### Dashboard hiển thị:
```
✅ Giai đoạn 1-4: Hoàn thành
   • Ngày phân công: 08/02/2026
   • Số lượng phản biện: 2 người
     - PGS.TS. Nguyễn Thị B (Sinh học phân tử)
     - TS. Trần Văn C (Sinh lý động vật)
   • Thời hạn đánh giá: 15/02/2026
   
⏳ Chờ phản biện đánh giá (0/2 hoàn thành)

📊 Tiến độ phản biện:
   • PGS.TS. Nguyễn Thị B: ⏳ Đang đánh giá
   • TS. Trần Văn C: ⏳ Đang đánh giá
```

---

### **GIAI ĐOẠN 5: ĐÁNH GIÁ PHẢN BIỆN**
**Người thực hiện:** Thành viên Hội đồng được phân công  
**Thời gian:** 7 ngày

#### Hồ sơ cần upload:
| Mã tài liệu | Tên tài liệu | Người upload | Số lượng |
|------------|--------------|--------------|----------|
| SCI-ACE-PĐG | Phiếu nhận xét thành viên | Mỗi phản biện | 2-3 phiếu |

#### Nội dung đánh giá:
- Tính khoa học của nghiên cứu
- Tuân thủ nguyên tắc 3R
- Tính cần thiết sử dụng động vật
- Phương pháp giảm thiểu đau đớn
- **Kết luận:** Chấp thuận / Có điều kiện / Không chấp thuận

#### Trạng thái hồ sơ: Vẫn `UNDER_REVIEW`

#### Dashboard hiển thị (khi có phản biện hoàn thành):
```
✅ Giai đoạn 1-4: Hoàn thành
⏳ Giai đoạn 5: Đang thực hiện (1/2 hoàn thành)

📊 Tiến độ phản biện:
   • PGS.TS. Nguyễn Thị B: ✅ Đã đánh giá (12/02/2026)
     - Kết luận: CHẤP THUẬN
     - File: SCI-ACE-PĐG_NguyenThiB.docx
   • TS. Trần Văn C: ⏳ Đang đánh giá (Còn 3 ngày)

⏰ Nhắc nhở: Gửi email nhắc TS. Trần Văn C
```

#### Dashboard khi đủ 2 phản biện:
```
✅ Giai đoạn 1-5: Hoàn thành
   
📊 Kết quả phản biện:
   • PGS.TS. Nguyễn Thị B: ✅ CHẤP THUẬN
   • TS. Trần Văn C: ⚠️ CÓ ĐIỀU KIỆN
     (Yêu cầu bổ sung phương pháp giảm đau)

⏳ Chờ lên lịch họp Hội đồng
```

---

### **GIAI ĐOẠN 6: HỌP HỘI ĐỒNG**
**Người thực hiện:** Toàn thể Hội đồng  
**Thời gian:** Theo lịch họp định kỳ

#### Điều kiện:
- Ít nhất 2/3 thành viên tham dự
- Có đủ phiếu nhận xét phản biện

#### Hồ sơ cần upload sau họp:
| Mã tài liệu | Tên tài liệu | Người upload |
|------------|--------------|--------------|
| SCI-ACE-05 | Biên bản họp | Thư ký |

#### Trạng thái hồ sơ: `IN_MEETING` (Đang họp)

#### Ba kết quả có thể:

##### **A. CHẤP THUẬN (APPROVED)**
```
✅ Giai đoạn 1-6: Hoàn thành
   • Ngày họp: 18/02/2026
   • Số lượng thành viên: 8/10 (80%)
   • Kết quả bỏ phiếu: 7 chấp thuận / 1 có điều kiện
   • Quyết định: CHẤP THUẬN
   • File biên bản: SCI-ACE-05_20260218.docx

⏳ Tiếp theo: Cấp Quyết định phê duyệt (Giai đoạn 7)
```

##### **B. CHẤP THUẬN CÓ ĐIỀU KIỆN (CONDITIONAL)**
```
✅ Giai đoạn 1-6: Hoàn thành
   • Ngày họp: 18/02/2026
   • Kết quả: CHẤP THUẬN CÓ ĐIỀU KIỆN
   • Yêu cầu bổ sung:
     1. Bổ sung phương pháp giảm đau trong phần 4.3
     2. Làm rõ số lượng động vật dự trữ
   • Thời hạn bổ sung: 30 ngày (đến 20/03/2026)

📝 Nghiên cứu viên cần upload:
   • SCI-ACE-04: Báo cáo giải trình tiếp thu
   • SCI-ACE-02 (bản sửa đổi)
   
➡️ Quay lại Giai đoạn 5 (đánh giá lại)
```

##### **C. KHÔNG CHẤP THUẬN (REJECTED)**
```
✅ Giai đoạn 1-6: Hoàn thành
   • Ngày họp: 18/02/2026
   • Kết quả: KHÔNG CHẤP THUẬN
   • Lý do:
     - Chưa chứng minh được tính cần thiết sử dụng động vật
     - Chưa tuân thủ nguyên tắc Replacement (3R)
   • File biên bản: SCI-ACE-05_20260218.docx

❌ KẾT THÚC QUY TRÌNH
   Nghiên cứu viên có thể nộp lại sau khi chỉnh sửa cơ bản
```

---

### **GIAI ĐOẠN 7: CẤP QUYẾT ĐỊNH**
**Người thực hiện:** Chủ tịch Hội đồng  
**Thời gian:** 3 ngày sau họp

*Chỉ áp dụng khi kết quả là CHẤP THUẬN*

#### Hồ sơ cần upload:
| Mã tài liệu | Tên tài liệu | Người upload | Ghi chú |
|------------|--------------|--------------|---------|
| SCI-ACE-QĐ (VN) | Quyết định phê duyệt (Tiếng Việt) | Chủ tịch/Thư ký | Có chữ ký, con dấu |
| SCI-ACE-QĐ (EN) | Decision (English) | Chủ tịch/Thư ký | Có chữ ký, con dấu |

#### Trạng thái hồ sơ: `APPROVED` (Đã phê duyệt)

#### Dashboard hiển thị:
```
✅ Giai đoạn 1-7: Hoàn thành
   • Ngày cấp QĐ: 21/02/2026
   • Số Quyết định: 01/QĐ-HĐĐĐĐV-2026
   • Có hiệu lực từ: 21/02/2026
   • Có hiệu lực đến: 21/02/2027 (1 năm)
   • Files:
     - SCI-ACE-QD_VN_01-2026.pdf ✅
     - SCI-ACE-QD_EN_01-2026.pdf ✅

📧 Đã gửi email thông báo đến Nghiên cứu viên

⏳ Tiếp theo: Nghiên cứu viên thực hiện nghiên cứu (Giai đoạn 8)
```

---

### **GIAI ĐOẠN 8: THỰC HIỆN & BÁO CÁO**
**Người thực hiện:** Nghiên cứu viên  
**Thời gian:** Theo tiến độ nghiên cứu (thường 6-12 tháng)

#### Trạng thái hồ sơ: `IMPLEMENTATION` (Đang thực hiện)

#### Các tình huống có thể xảy ra:

##### **A. Có thay đổi so với đề cương:**
**Hồ sơ cần upload:**
| Mã tài liệu | Tên tài liệu | Thời điểm | Ghi chú |
|------------|--------------|-----------|---------|
| SCI-ACE-06 | Báo cáo thay đổi kế hoạch | TRƯỚC KHI thực hiện thay đổi | Bắt buộc |

**Dashboard hiển thị:**
```
✅ Giai đoạn 1-7: Hoàn thành
⏳ Giai đoạn 8: Đang thực hiện

📋 Báo cáo thay đổi:
   • Ngày báo cáo: 15/04/2026
   • File: SCI-ACE-06_Thay_doi_so_luong_chuot.docx
   • Nội dung: Tăng số lượng chuột từ 30 lên 45 con
   • Trạng thái: ⏳ Chờ Hội đồng xem xét
   
⚠️ QUAN TRỌNG: Nghiên cứu viên KHÔNG được thực hiện 
   thay đổi cho đến khi nhận được phê duyệt
```

##### **B. Báo cáo định kỳ:**
**Hồ sơ cần upload:**
| Mã tài liệu | Tên tài liệu | Tần suất | Ghi chú |
|------------|--------------|----------|---------|
| SCI-ACE-07 | Báo cáo kết quả tuân thủ | 6 tháng/lần | Theo yêu cầu của QĐ |

**Dashboard hiển thị:**
```
✅ Giai đoạn 1-7: Hoàn thành
⏳ Giai đoạn 8: Đang thực hiện (Tháng 6/12)

📊 Báo cáo tiến độ:
   • Báo cáo lần 1: ✅ Đã nộp (21/08/2026)
     - File: SCI-ACE-07_Lan1.docx
     - Trạng thái: Đạt yêu cầu
   • Báo cáo lần 2: ⏰ Sắp đến hạn (21/02/2027)
   
🔔 Nhắc nhở: Cần nộp báo cáo lần 2 trước 21/02/2027
```

##### **C. Hoàn thành nghiên cứu:**
**Hồ sơ cần upload:**
| Mã tài liệu | Tên tài liệu | Thời điểm | Ghi chú |
|------------|--------------|-----------|---------|
| SCI-ACE-07 | Báo cáo kết quả tuân thủ (Kết thúc) | Sau khi hoàn thành | Bắt buộc |

**Dashboard hiển thị:**
```
✅ Giai đoạn 1-8: HOÀN THÀNH TẤT CẢ

📊 Tổng kết:
   • Ngày bắt đầu: 21/02/2026
   • Ngày kết thúc: 15/12/2026
   • Tổng thời gian: 9 tháng 24 ngày
   • Báo cáo kết thúc: ✅ Đã nộp (20/12/2026)
     - File: SCI-ACE-07_Ket_thuc.docx
   • Kết luận: ĐẠT YÊU CẦU, tuân thủ tốt quy định

🎉 HỒ SƠ ĐÓNG
```

---

## 📊 BẢNG TỔNG HỢP HỒ SƠ THEO GIAI ĐOẠN

| Giai đoạn | Người thực hiện | Tài liệu upload | Bắt buộc | Thời hạn |
|-----------|----------------|----------------|----------|----------|
| 1. Chuẩn bị | Nghiên cứu viên | SCI-ACE-01, 02, 03 + Đính kèm | ✅ | Không giới hạn |
| 2. Nộp hồ sơ | Nghiên cứu viên | (Hệ thống tự động) | - | - |
| 3. Kiểm tra | Thư ký | (Không upload, chỉ validate) | - | 3 ngày |
| 4. Phân công | Chủ tịch | (Hệ thống phân công) | - | 2 ngày |
| 5. Đánh giá | Thành viên HĐ | SCI-ACE-PĐG (mỗi người) | ✅ | 7 ngày |
| 6. Họp | Thư ký | SCI-ACE-05 (Biên bản) | ✅ | Ngay sau họp |
| 7. Cấp QĐ | Chủ tịch | SCI-ACE-QĐ (VN + EN) | ✅ | 3 ngày |
| 8A. Thay đổi | Nghiên cứu viên | SCI-ACE-06 | ✅ | Trước khi thay đổi |
| 8B. Báo cáo | Nghiên cứu viên | SCI-ACE-07 | ✅ | Theo lịch / Kết thúc |
| 8C. Giải trình | Nghiên cứu viên | SCI-ACE-04 | ⚠️ | 30 ngày (nếu yêu cầu) |

---

## 🎯 DASHBOARD QUẢN TRỊ - GIAO DIỆN ĐÁNH GIÁ NHANH

### **View tổng quan (Admin/Chủ tịch):**

```
╔══════════════════════════════════════════════════════════════════╗
║  DASHBOARD - QUẢN LÝ HỒ SƠ ĐẠO ĐỨC                              ║
╠══════════════════════════════════════════════════════════════════╣
║  📊 Thống kê tổng quan:                                          ║
║     • Tổng hồ sơ: 45                                            ║
║     • Đang chờ xử lý: 12                                        ║
║     • Quá hạn: 3 🔴                                             ║
║     • Hoàn thành tháng này: 8                                   ║
╠══════════════════════════════════════════════════════════════════╣
║  🔴 CẦN XỬ LÝ GẤP (3)                                            ║
║  ┌────────────────────────────────────────────────────────┐     ║
║  │ #2024-045 - Nghiên cứu tế bào gốc chuột                │     ║
║  │ 📍 Giai đoạn 5: Chờ phản biện (2/2)                    │     ║
║  │ ⏰ QUÁ HẠN 2 ngày - TS. Trần Văn C chưa nộp           │     ║
║  │ [Nhắc nhở] [Xem chi tiết]                              │     ║
║  └────────────────────────────────────────────────────────┘     ║
║                                                                   ║
║  │ #2024-047 - Nghiên cứu hành vi thỏ                     │     ║
║  │ 📍 Giai đoạn 3: Chờ kiểm tra                           │     ║
║  │ ⏰ QUÁ HẠN 1 ngày                                      │     ║
║  │ [Xử lý ngay] [Xem chi tiết]                            │     ║
║  └────────────────────────────────────────────────────────┘     ║
╠══════════════════════════════════════════════════════════════════╣
║  ⏳ ĐANG XỬ LÝ (9)                                               ║
║  ┌────────────────────────────────────────────────────────┐     ║
║  │ #2024-048 - Nghiên cứu enzyme gan chuột                │     ║
║  │ 📍 Giai đoạn 5: Chờ phản biện (1/2 hoàn thành)         │     ║
║  │ ⏰ Còn 5 ngày                                          │     ║
║  │ [Xem chi tiết]                                         │     ║
║  └────────────────────────────────────────────────────────┘     ║
║  ... (xem tất cả)                                                ║
╚══════════════════════════════════════════════════════════════════╝
```

### **View chi tiết từng hồ sơ:**

```
╔══════════════════════════════════════════════════════════════════╗
║  HỒ SƠ #2024-048: Nghiên cứu enzyme gan chuột                   ║
║  Nghiên cứu viên: nguyenvana@sci.edu.vn                         ║
║  Ngày nộp: 15/01/2026                                           ║
╠══════════════════════════════════════════════════════════════════╣
║  TIẾN TRÌNH QUY TRÌNH                                            ║
║                                                                   ║
║  ✅ GIAI ĐOẠN 1: Chuẩn bị hồ sơ                                  ║
║     └─ Hoàn thành: 14/01/2026                                   ║
║                                                                   ║
║  ✅ GIAI ĐOẠN 2: Nộp hồ sơ                                       ║
║     └─ Ngày nộp: 15/01/2026 10:30                              ║
║     └─ Email xác nhận: ✓ Đã gửi                                ║
║                                                                   ║
║  ✅ GIAI ĐOẠN 3: Kiểm tra hồ sơ                                  ║
║     └─ Người kiểm tra: Thư ký Nguyễn Thị X                      ║
║     └─ Ngày kiểm tra: 17/01/2026                               ║
║     └─ Kết quả: HỢP LỆ ✓                                        ║
║                                                                   ║
║  ✅ GIAI ĐOẠN 4: Phân công phản biện                             ║
║     └─ Ngày phân công: 18/01/2026                              ║
║     └─ Phản biện 1: PGS.TS. Nguyễn Thị B                       ║
║     └─ Phản biện 2: TS. Trần Văn C                             ║
║     └─ Thời hạn: 25/01/2026                                    ║
║                                                                   ║
║  ⏳ GIAI ĐOẠN 5: Đánh giá phản biện (50%)                        ║
║     └─ PGS.TS. Nguyễn Thị B: ✅ Hoàn thành (20/01)              ║
║        • Kết luận: CHẤP THUẬN                                   ║
║        • File: SCI-ACE-PDG_NguyenThiB.docx                      ║
║        • [Xem file]                                             ║
║     └─ TS. Trần Văn C: ⏳ Đang đánh giá                          ║
║        • Còn: 5 ngày                                            ║
║        • [Gửi nhắc nhở]                                         ║
║                                                                   ║
║  ⬜ GIAI ĐOẠN 6: Họp Hội đồng                                     ║
║     └─ Chưa lên lịch                                            ║
║                                                                   ║
║  ⬜ GIAI ĐOẠN 7: Cấp Quyết định                                   ║
║  ⬜ GIAI ĐOẠN 8: Thực hiện & Báo cáo                              ║
╠══════════════════════════════════════════════════════════════════╣
║  TÀI LIỆU ĐÃ UPLOAD                                             ║
║                                                                   ║
║  📁 Hồ sơ ban đầu (Giai đoạn 1):                                ║
║     ✅ SCI-ACE-01.docx (125 KB) - 14/01/2026                     ║
║     ✅ SCI-ACE-02.docx (342 KB) - 14/01/2026                     ║
║     ✅ SCI-ACE-03.docx (156 KB) - 14/01/2026                     ║
║     ✅ Thuyet_minh_de_tai.pdf (1.2 MB) - 14/01/2026             ║
║     ✅ CV_nguoi_huong_dan.pdf (234 KB) - 14/01/2026             ║
║                                                                   ║
║  📁 Phản biện (Giai đoạn 5):                                     ║
║     ✅ SCI-ACE-PDG_NguyenThiB.docx (89 KB) - 20/01/2026          ║
║     ⏳ Chờ: SCI-ACE-PDG_TranVanC.docx                            ║
║                                                                   ║
║  📁 Còn thiếu:                                                   ║
║     ⏳ SCI-ACE-05: Biên bản họp (sau Giai đoạn 6)               ║
║     ⏳ SCI-ACE-QĐ: Quyết định phê duyệt (sau Giai đoạn 7)        ║
╠══════════════════════════════════════════════════════════════════╣
║  HÀNH ĐỘNG                                                       ║
║  [Gửi nhắc nhở phản biện] [Lên lịch họp] [Tải tất cả file]    ║
║  [Chỉnh sửa thông tin] [In báo cáo] [Lưu trữ]                  ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## 🚨 CÁC CẢNH BÁO VÀ NHẮC NHỞ TỰ ĐỘNG

### **1. Nhắc nhở quá hạn:**
```
🔴 CẢNH BÁO: Hồ sơ #2024-045
   • Giai đoạn 5: Phản biện TS. Trần Văn C
   • Quá hạn: 2 ngày
   • Hành động: Đã gửi email nhắc nhở lần 2
   • Nếu quá 5 ngày: Phân công phản biện mới
```

### **2. Nhắc nhở sắp đến hạn:**
```
⚠️ SẮP ĐẾN HẠN: Hồ sơ #2024-048
   • Giai đoạn 5: Chờ phản biện TS. Trần Văn C
   • Còn: 2 ngày
   • Hành động đề xuất: Gửi email nhắc nhở
```

### **3. Nhắc nhở nghiên cứu viên:**
```
📅 NHẮC NHỞ: Hồ sơ #2024-042
   • Nghiên cứu viên: nguyenvanb@sci.edu.vn
   • Báo cáo định kỳ sắp đến hạn
   • Cần nộp SCI-ACE-07 trước: 15/02/2026 (còn 7 ngày)
```

---

## 📈 BÁO CÁO THỐNG KÊ

### **Báo cáo theo trạng thái:**
```
┌─────────────────────────────────────────┐
│ TRẠNG THÁI HỒ SƠ (Tháng 1/2026)        │
├─────────────────────────────────────────┤
│ Nháp (DRAFT):              5 hồ sơ     │
│ Đã nộp (SUBMITTED):        8 hồ sơ     │
│ Đang đánh giá (UNDER_REVIEW): 12 hồ sơ │
│ Đang họp (IN_MEETING):     2 hồ sơ     │
│ Đã phê duyệt (APPROVED):   15 hồ sơ    │
│ Cần bổ sung (NEED_REVISION): 2 hồ sơ  │
│ Không chấp thuận (REJECTED): 1 hồ sơ  │
└─────────────────────────────────────────┘
```

### **Báo cáo theo thời gian xử lý:**
```
┌─────────────────────────────────────────┐
│ THỜI GIAN XỬ LÝ TRUNG BÌNH             │
├─────────────────────────────────────────┤
│ Giai đoạn 1-2: Tùy nghiên cứu viên     │
│ Giai đoạn 3:   2.5 ngày                │
│ Giai đoạn 4:   1.8 ngày                │
│ Giai đoạn 5:   6.2 ngày                │
│ Giai đoạn 6:   (Theo lịch họp)         │
│ Giai đoạn 7:   2.1 ngày                │
│                                         │
│ TỔNG THỜI GIAN: 18-25 ngày             │
│ (Không tính thời gian chờ họp)         │
└─────────────────────────────────────────┘
```

---

## 🔔 HỆ THỐNG THÔNG BÁO EMAIL TỰ ĐỘNG

### **Giai đoạn 2 - Sau khi nộp:**
```
ĐẾN: nguyenvana@sci.edu.vn
CC: thuky@sci.edu.vn
TIÊU ĐỀ: [SCI-ACE] Đã nhận hồ sơ #2024-048

Kính gửi anh/chị Nguyễn Văn A,

Hệ thống đã nhận được hồ sơ xét duyệt đạo đức của anh/chị.

Mã hồ sơ: #2024-048
Tên đề tài: Nghiên cứu enzyme gan chuột
Ngày nộp: 15/01/2026 10:30

Hồ sơ của anh/chị sẽ được Thư ký Hội đồng kiểm tra trong vòng 3 ngày làm việc.

Trân trọng,
Hệ thống SCI-ACE
```

### **Giai đoạn 5 - Nhắc phản biện:**
```
ĐẾN: tranvanc@sci.edu.vn
CC: chutich@sci.edu.vn
TIÊU ĐỀ: [SCI-ACE] Nhắc nhở: Đánh giá hồ sơ #2024-048

Kính gửi TS. Trần Văn C,

Anh/chị được phân công phản biện hồ sơ #2024-048.

Thời hạn đánh giá: 25/01/2026 (còn 2 ngày)

Vui lòng hoàn thành và upload phiếu nhận xét SCI-ACE-PĐG.

[Truy cập hệ thống] [Tải hồ sơ]

Trân trọng,
```

### **Giai đoạn 7 - Thông báo có Quyết định:**
```
ĐẾN: nguyenvana@sci.edu.vn
CC: chutich@sci.edu.vn, thuky@sci.edu.vn
TIÊU ĐỀ: [SCI-ACE] ✅ Đề nghị đã được chấp thuận - QĐ #01/2026

Kính gửi anh/chị Nguyễn Văn A,

Hội đồng Đạo đức đã CHẤP THUẬN đề nghị của anh/chị.

Số Quyết định: 01/QĐ-HĐĐĐĐV-2026
Có hiệu lực từ: 21/02/2026 đến 21/02/2027

Anh/chị có thể tải Quyết định (2 phiên bản) tại hệ thống.

LƯU Ý:
- Báo cáo định kỳ 6 tháng/lần
- Mọi thay đổi phải được phê duyệt trước

[Tải Quyết định tiếng Việt] [Tải Decision (English)]

Trân trọng,
Chủ tịch Hội đồng
```

---

## 📝 CHECKLIST QUẢN TRỊ

### **Cho Thư ký:**
- [ ] Kiểm tra hồ sơ mới trong vòng 3 ngày
- [ ] Đảm bảo phân công phản biện đúng hạn
- [ ] Theo dõi tiến độ phản biện
- [ ] Chuẩn bị tài liệu họp
- [ ] Viết biên bản họp
- [ ] Lưu trữ đầy đủ tài liệu

### **Cho Chủ tịch:**
- [ ] Phân công phản biện hợp lý
- [ ] Chủ trì họp Hội đồng
- [ ] Ký Quyết định phê duyệt
- [ ] Theo dõi hồ sơ quá hạn
- [ ] Xem xét báo cáo thống kê

### **Cho Thành viên Hội đồng:**
- [ ] Hoàn thành đánh giá đúng hạn
- [ ] Upload phiếu nhận xét
- [ ] Tham dự họp (≥2/3 thành viên)
- [ ] Bỏ phiếu quyết định

### **Cho Nghiên cứu viên:**
- [ ] Chuẩn bị đầy đủ hồ sơ ban đầu
- [ ] Bổ sung theo yêu cầu (nếu có)
- [ ] Báo cáo thay đổi kịp thời
- [ ] Báo cáo định kỳ đúng hạn
- [ ] Báo cáo kết thúc

---

## 🎓 KẾT LUẬN

Quy trình upload hồ sơ trong hệ thống SCI-ACE được thiết kế:

1. **Rõ ràng**: Mỗi vai trò biết chính xác mình cần làm gì ở giai đoạn nào
2. **Minh bạch**: Admin/Hội đồng thấy được tiến trình real-time
3. **Tự động**: Email thông báo và nhắc nhở tự động
4. **Tuân thủ**: Đảm bảo đúng quy trình đạo đức nghiên cứu
5. **Hiệu quả**: Giảm thời gian xử lý, tránh quá hạn

**Thời gian trung bình hoàn thành một hồ sơ: 18-25 ngày**  
(Không tính thời gian chờ lịch họp và thời gian nghiên cứu viên chuẩn bị)

---

*Tài liệu này có thể được cập nhật theo phản hồi từ người dùng thực tế.*

**Phiên bản:** 1.0  
**Ngày cập nhật:** 03/02/2026  
**Người soạn:** Claude AI Assistant
