# SƠ ĐỒ QUY TRÌNH UPLOAD HỒ SƠ - SCI-ACE

## 1. SƠ ĐỒ TỔNG QUAN QUY TRÌNH

```mermaid
flowchart TD
    Start([Bắt đầu]) --> GD1[Giai đoạn 1: Chuẩn bị hồ sơ<br/>Nghiên cứu viên]
    
    GD1 --> Upload1{Upload:<br/>SCI-ACE-01, 02, 03<br/>+ Tài liệu đính kèm}
    Upload1 --> GD2[Giai đoạn 2: Nộp hồ sơ<br/>Nghiên cứu viên]
    
    GD2 --> Auto1[🔔 Email tự động<br/>→ Thư ký<br/>→ Nghiên cứu viên]
    Auto1 --> GD3[Giai đoạn 3: Kiểm tra hồ sơ<br/>Thư ký - 3 ngày]
    
    GD3 --> Check1{Hồ sơ<br/>hợp lệ?}
    Check1 -->|Không| Reject1[Yêu cầu bổ sung]
    Reject1 --> GD1
    
    Check1 -->|Có| GD4[Giai đoạn 4: Phân công phản biện<br/>Chủ tịch - 2 ngày]
    GD4 --> Assign[Phân công ≥2 phản biện]
    
    Assign --> GD5[Giai đoạn 5: Đánh giá phản biện<br/>Thành viên HĐ - 7 ngày]
    GD5 --> Upload2{Upload:<br/>SCI-ACE-PĐG<br/>từng phản biện}
    
    Upload2 --> Check2{Đủ 2<br/>phản biện?}
    Check2 -->|Chưa| Remind1[🔔 Nhắc nhở]
    Remind1 --> GD5
    
    Check2 -->|Đủ| GD6[Giai đoạn 6: Họp Hội đồng<br/>Toàn thể - Theo lịch]
    GD6 --> Upload3{Upload:<br/>SCI-ACE-05<br/>Biên bản họp}
    
    Upload3 --> Decision{Quyết định<br/>Hội đồng}
    
    Decision -->|Không chấp thuận| Reject2[❌ Từ chối<br/>Thông báo lý do]
    Reject2 --> End1([Kết thúc])
    
    Decision -->|Có điều kiện| Condition[⚠️ Yêu cầu chỉnh sửa<br/>30 ngày]
    Condition --> Upload4{Nghiên cứu viên upload:<br/>SCI-ACE-04<br/>Báo cáo giải trình}
    Upload4 --> GD5
    
    Decision -->|Chấp thuận| GD7[Giai đoạn 7: Cấp Quyết định<br/>Chủ tịch - 3 ngày]
    GD7 --> Upload5{Upload:<br/>SCI-ACE-QĐ<br/>VN + EN}
    
    Upload5 --> Auto2[🔔 Email Quyết định<br/>→ Nghiên cứu viên]
    Auto2 --> GD8[Giai đoạn 8: Thực hiện nghiên cứu<br/>Nghiên cứu viên]
    
    GD8 --> Situation{Tình huống}
    
    Situation -->|Có thay đổi| Upload6{Upload:<br/>SCI-ACE-06<br/>TRƯỚC KHI thay đổi}
    Upload6 --> Review[Hội đồng xem xét]
    Review --> GD8
    
    Situation -->|Báo cáo định kỳ| Upload7{Upload:<br/>SCI-ACE-07<br/>6 tháng/lần}
    Upload7 --> GD8
    
    Situation -->|Hoàn thành| Upload8{Upload:<br/>SCI-ACE-07<br/>Báo cáo kết thúc}
    Upload8 --> End2([✅ Hoàn thành])
    
    style GD1 fill:#e8f5e9
    style GD2 fill:#e8f5e9
    style GD3 fill:#fff9e6
    style GD4 fill:#fff9e6
    style GD5 fill:#e3f2fd
    style GD6 fill:#e3f2fd
    style GD7 fill:#f3e5f5
    style GD8 fill:#fce4ec
    style Reject1 fill:#ffebee
    style Reject2 fill:#ffebee
    style Condition fill:#fff3e0
    style End2 fill:#c8e6c9
```

## 2. SƠ ĐỒ VAI TRÒ VÀ TRÁCH NHIỆM

```mermaid
graph TB
    subgraph "NGHIÊN CỨU VIÊN"
        R1[Upload SCI-ACE-01, 02, 03]
        R2[Nộp hồ sơ]
        R3[Bổ sung nếu yêu cầu]
        R4[Upload SCI-ACE-04 nếu cần]
        R5[Upload SCI-ACE-06 khi thay đổi]
        R6[Upload SCI-ACE-07 định kỳ]
    end
    
    subgraph "THƯ KÝ"
        S1[Kiểm tra hồ sơ - 3 ngày]
        S2[Theo dõi tiến độ]
        S3[Upload SCI-ACE-05 Biên bản]
        S4[Gửi thông báo]
    end
    
    subgraph "CHỦ TỊCH"
        C1[Phân công phản biện]
        C2[Chủ trì họp]
        C3[Upload SCI-ACE-QĐ VN+EN]
        C4[Ký Quyết định]
    end
    
    subgraph "THÀNH VIÊN HỘI ĐỒNG"
        M1[Nhận hồ sơ]
        M2[Đánh giá - 7 ngày]
        M3[Upload SCI-ACE-PĐG]
        M4[Tham dự họp ≥2/3]
    end
    
    R2 --> S1
    S1 --> C1
    C1 --> M1
    M2 --> M3
    M3 --> S2
    S2 --> C2
    C2 --> S3
    S3 --> C3
    C3 --> C4
    C4 --> R5
    
    style R1 fill:#e8f5e9
    style R2 fill:#e8f5e9
    style S1 fill:#fff9e6
    style C1 fill:#e3f2fd
    style M3 fill:#f3e5f5
```

## 3. SƠ ĐỒ TRẠNG THÁI HỒ SƠ

```mermaid
stateDiagram-v2
    [*] --> DRAFT: Nghiên cứu viên tạo hồ sơ
    DRAFT --> SUBMITTED: Nhấn "Gửi hồ sơ"
    SUBMITTED --> NEED_REVISION: Thư ký yêu cầu bổ sung
    NEED_REVISION --> DRAFT: Nghiên cứu viên chỉnh sửa
    SUBMITTED --> VALIDATED: Thư ký phê duyệt
    VALIDATED --> UNDER_REVIEW: Chủ tịch phân công
    UNDER_REVIEW --> UNDER_REVIEW: Chờ đủ phản biện
    UNDER_REVIEW --> IN_MEETING: Lên lịch họp
    IN_MEETING --> REJECTED: Không chấp thuận
    IN_MEETING --> CONDITIONAL: Có điều kiện
    IN_MEETING --> APPROVED: Chấp thuận
    CONDITIONAL --> UNDER_REVIEW: Nộp SCI-ACE-04
    APPROVED --> IMPLEMENTATION: Cấp Quyết định
    IMPLEMENTATION --> IMPLEMENTATION: Báo cáo định kỳ
    IMPLEMENTATION --> COMPLETED: Hoàn thành
    REJECTED --> [*]
    COMPLETED --> [*]
    
    note right of DRAFT
        Hồ sơ: SCI-ACE-01, 02, 03
    end note
    
    note right of UNDER_REVIEW
        Hồ sơ: SCI-ACE-PĐG x2+
    end note
    
    note right of IN_MEETING
        Hồ sơ: SCI-ACE-05
    end note
    
    note right of APPROVED
        Hồ sơ: SCI-ACE-QĐ (VN+EN)
    end note
    
    note right of IMPLEMENTATION
        Hồ sơ: SCI-ACE-06, 07
    end note
```

## 4. TIMELINE QUY TRÌNH (GANTT CHART)

```mermaid
gantt
    title Quy trình xét duyệt đạo đức - Timeline 30 ngày
    dateFormat YYYY-MM-DD
    
    section Nghiên cứu viên
    Chuẩn bị hồ sơ (GĐ1)    :done, r1, 2026-01-01, 14d
    Nộp hồ sơ (GĐ2)         :done, r2, 2026-01-15, 1d
    
    section Thư ký
    Kiểm tra hồ sơ (GĐ3)    :active, s1, 2026-01-16, 3d
    
    section Chủ tịch
    Phân công phản biện (GĐ4) :c1, 2026-01-19, 2d
    
    section Thành viên HĐ
    Đánh giá phản biện (GĐ5)  :m1, 2026-01-21, 7d
    
    section Hội đồng
    Họp Hội đồng (GĐ6)       :meeting, 2026-01-28, 1d
    
    section Chủ tịch
    Cấp Quyết định (GĐ7)     :c2, 2026-01-29, 3d
    
    section Nghiên cứu viên
    Nhận QĐ & Thực hiện (GĐ8) :r3, 2026-02-01, 180d
```

## 5. SƠ ĐỒ CHECKLIST THEO GIAI ĐOẠN

```mermaid
graph LR
    subgraph "GĐ1-2: Chuẩn bị & Nộp"
        A1[✓ SCI-ACE-01]
        A2[✓ SCI-ACE-02]
        A3[✓ SCI-ACE-03]
        A4[⚠️ Đính kèm]
    end
    
    subgraph "GĐ3-4: Kiểm tra & Phân công"
        B1[✓ Kiểm tra đầy đủ]
        B2[✓ Validate]
        B3[✓ Phân công ≥2]
    end
    
    subgraph "GĐ5: Đánh giá"
        C1[✓ PĐG 1]
        C2[✓ PĐG 2]
        C3[⚠️ PĐG 3]
    end
    
    subgraph "GĐ6: Họp"
        D1[✓ ≥2/3 thành viên]
        D2[✓ Biên bản họp]
        D3[✓ Quyết định]
    end
    
    subgraph "GĐ7: Cấp QĐ"
        E1[✓ QĐ tiếng Việt]
        E2[✓ QĐ English]
        E3[✓ Chữ ký + Con dấu]
    end
    
    subgraph "GĐ8: Thực hiện"
        F1[⚠️ SCI-ACE-06]
        F2[✓ SCI-ACE-07]
        F3[⚠️ SCI-ACE-04]
    end
    
    A1 --> B1
    A2 --> B1
    A3 --> B1
    A4 --> B1
    B3 --> C1
    B3 --> C2
    C1 --> D1
    C2 --> D1
    D2 --> E1
    D3 --> E1
    E1 --> F2
    E2 --> F2
    
    style A1 fill:#c8e6c9
    style A2 fill:#c8e6c9
    style A3 fill:#c8e6c9
    style A4 fill:#fff9c4
    style F1 fill:#fff9c4
    style F3 fill:#fff9c4
```

## 6. MA TRẬN TRÁCH NHIỆM (RACI)

```mermaid
graph TD
    subgraph "MA TRẬN RACI"
        T1[Giai đoạn]
        
        subgraph "Vai trò"
            R[Nghiên cứu viên]
            S[Thư ký]
            C[Chủ tịch]
            M[Thành viên HĐ]
        end
    end
    
    GD1[GĐ1: Chuẩn bị] --> R1[R: Responsible]
    GD2[GĐ2: Nộp] --> R2[R: Responsible]
    GD3[GĐ3: Kiểm tra] --> S1[R: Responsible<br/>A: Accountable]
    GD4[GĐ4: Phân công] --> C1[R: Responsible<br/>A: Accountable]
    GD5[GĐ5: Đánh giá] --> M1[R: Responsible<br/>C: Consulted]
    GD6[GĐ6: Họp] --> M2[R: Responsible<br/>C: Chủ tịch<br/>I: Thư ký]
    GD7[GĐ7: Cấp QĐ] --> C2[R: Responsible<br/>A: Accountable]
    GD8[GĐ8: Thực hiện] --> R3[R: Responsible<br/>I: Hội đồng]
    
    style R1 fill:#e8f5e9
    style S1 fill:#fff9e6
    style C1 fill:#e3f2fd
    style M1 fill:#f3e5f5
    style C2 fill:#fce4ec
```

**Chú thích RACI:**
- **R (Responsible)**: Người thực hiện trực tiếp
- **A (Accountable)**: Người chịu trách nhiệm cuối cùng
- **C (Consulted)**: Người được tham vấn
- **I (Informed)**: Người được thông báo

---

*Các sơ đồ này có thể được render bằng Mermaid Live Editor hoặc tích hợp vào các công cụ như Notion, GitHub, GitLab.*

**Lưu ý:** Copy các đoạn code Mermaid vào https://mermaid.live để xem trực quan.
