-- Schema cho Module Quản lý Đề tài Nghiên cứu Khoa học Cấp Viện (Viện Tế bào gốc - SCI)

CREATE TABLE IF NOT EXISTS nckh_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,                  -- Mã số đề tài: NCKH-SCI.01/24...
    title TEXT NOT NULL,                        -- Tên đề tài
    leader_name TEXT NOT NULL,                  -- Tên chủ nhiệm đề tài
    members TEXT,                               -- Thành viên tham gia
    category TEXT DEFAULT 'Cơ bản',            -- Loại đề tài: Cơ bản, Ứng dụng
    research_group TEXT,                        -- Nhóm nghiên cứu: Biochip, Stem Cell Biology...
    budget_total REAL DEFAULT 0,                -- Kinh phí dự toán (VNĐ)
    budget_revised REAL,                        -- Chỉnh sửa dự toán (nếu có)
    budget_approval_status TEXT DEFAULT 'DRAFT',-- DRAFT (Bản nháp) | LOCKED (Đã chốt khóa theo bản mộc đỏ)
    budget_locked_at TEXT,                      -- Thời điểm chốt khóa dự toán gốc
    budget_locked_by TEXT,                      -- Người chốt khóa dự toán gốc
    budget_approval_doc_id INTEGER,             -- ID tệp scan PDF Dự toán có dấu mộc đỏ (nckh_documents)
    submission_date TEXT,                       -- Ngày nộp hồ sơ
    council_date TEXT,                          -- Ngày họp Hội đồng xét duyệt
    council_result TEXT DEFAULT 'Đạt',          -- Kết quả xét duyệt: Đạt, Không đạt
    decision_number TEXT,                       -- Số Quyết định giao nhiệm vụ KHCN
    decision_date TEXT,                         -- Ngày ban hành Quyết định giao nhiệm vụ (Ngày bắt đầu)
    duration_months INTEGER DEFAULT 12,         -- Thời gian thực hiện gốc (thường 6 hoặc 12 tháng)
    base_end_date TEXT,                         -- Ngày hết hạn gốc (YYYY-MM-DD)
    current_end_date TEXT,                      -- Ngày hết hạn hiện tại (sau khi gia hạn)
    extension_count INTEGER DEFAULT 0,          -- Số lần đã gia hạn (tối đa 2 lần)
    status TEXT DEFAULT 'IN_PROGRESS',          -- Trạng thái: DRAFT, IN_PROGRESS, COMPLETED, CANCELLED
    final_evaluation TEXT,                      -- Nghiệm thu hay hủy đề tài: Nghiệm thu, Hủy đề tài...
    missing_docs TEXT,                          -- Giấy tờ còn thiếu (Đã xong, Thiếu tất cả, thuyết minh...)
    dossier_status TEXT,                        -- Tình trạng hồ sơ (1. Chưa có lịch, 2. Đang sắp xếp, 3. Đã có lịch)
    notes TEXT,                                 -- Ghi chú tổng hợp
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nckh_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    stage INTEGER NOT NULL,                     -- 1: Đăng ký, 2: Xét duyệt, 3: Giao việc & Dự toán, 4: Cấp phát, 5: Báo cáo 6T, 6: Gia hạn, 7: Nghiệm thu
    doc_type TEXT NOT NULL,                     -- THUYET_MINH, DE_CUONG, DU_TOAN_DA_DUYET, QD_GIAO_NHIEM_VU, HOP_DONG, BAO_CAO_6_THANG, DON_GIA_HAN, QD_GIA_HAN, BIEN_BAN_NGHIEM_THU, KHAC
    title TEXT NOT NULL,                        -- Tiêu đề văn bản hiển thị
    file_name TEXT NOT NULL,                    -- Tên file gốc
    stored_path TEXT NOT NULL,                  -- Đường dẫn lưu trữ tương đối trong thư mục uploads
    file_size INTEGER,                          -- Dung lượng file (bytes)
    mime_type TEXT,                             -- application/pdf, image/png...
    uploaded_by TEXT,                           -- Tên người upload
    uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    FOREIGN KEY (project_id) REFERENCES nckh_projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS nckh_periodic_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    period_num INTEGER NOT NULL,                -- Kỳ báo cáo: 1 (6 tháng), 2 (12 tháng), 3 (18 tháng)...
    due_date TEXT NOT NULL,                     -- Hạn nộp báo cáo (YYYY-MM-DD)
    submitted_date TEXT,                        -- Ngày nộp thực tế (YYYY-MM-DD)
    status TEXT DEFAULT 'PENDING',              -- PENDING, SUBMITTED, APPROVED, REVISION_NEEDED
    progress_summary TEXT,                      -- Tóm tắt kết quả thực hiện
    progress_percent INTEGER DEFAULT 0,         -- Tiến độ ước tính (%)
    report_file_id INTEGER,                     -- ID file Báo cáo tiến độ (nckh_documents)
    evidence_file_id INTEGER,                   -- ID file Minh chứng (nckh_documents)
    khcn_evaluation TEXT,                       -- Nhận xét / Đánh giá của P. KHCN
    evaluated_by TEXT,                          -- Cán bộ P. KHCN đánh giá
    evaluated_at TEXT,
    FOREIGN KEY (project_id) REFERENCES nckh_projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS nckh_extensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    extension_num INTEGER NOT NULL,             -- Lần 1 hoặc Lần 2 (Chặn cứng tối đa 2 lần)
    months_added INTEGER NOT NULL DEFAULT 6,    -- Cố định 6 tháng
    previous_end_date TEXT NOT NULL,            -- Ngày hết hạn trước đó
    new_end_date TEXT NOT NULL,                 -- Ngày hết hạn mới
    request_date TEXT NOT NULL,                 -- Ngày xin gia hạn
    reason TEXT NOT NULL,                       -- Lý do xin gia hạn
    decision_number TEXT,                       -- Số Quyết định gia hạn
    decision_date TEXT,                         -- Ngày ký Quyết định gia hạn
    status TEXT DEFAULT 'APPROVED',             -- PENDING, APPROVED, REJECTED
    request_file_id INTEGER,                    -- File Đơn xin gia hạn
    decision_file_id INTEGER,                   -- File Quyết định gia hạn
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES nckh_projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS nckh_budget_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    category TEXT DEFAULT 'Hóa chất & Vật tư',  -- Nhóm khoản mục chi
    item_name TEXT NOT NULL,                    -- Tên hóa chất / vật tư / sinh phẩm
    specification TEXT,                         -- Quy cách (Chai 500ml, Túi 1000 cái...)
    unit TEXT,                                  -- Đơn vị tính (Chai, Lọ, Kit, Con...)
    approved_quantity REAL NOT NULL DEFAULT 0,  -- Số lượng được duyệt trong dự toán
    original_quantity REAL,                     -- Số lượng duyệt gốc ban đầu (trước điều chỉnh)
    unit_price REAL DEFAULT 0,                  -- Đơn giá dự kiến (VNĐ)
    original_unit_price REAL,                   -- Đơn giá gốc ban đầu (trước điều chỉnh)
    total_price REAL DEFAULT 0,                 -- Thành tiền (VNĐ)
    notes TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES nckh_projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS nckh_supplies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    budget_item_id INTEGER,                     -- Liên kết với dự toán đã duyệt (nếu có)
    item_name TEXT NOT NULL,                    -- Tên hàng hóa xin cấp
    specification TEXT,                         -- Quy cách
    unit TEXT,                                  -- Đơn vị tính
    requested_quantity REAL NOT NULL DEFAULT 0, -- Số lượng xin cấp
    request_date TEXT,                          -- Ngày xin cấp
    budget_check_status TEXT DEFAULT 'Trong dự toán', -- Trong dự toán, Vượt định mức, Ngoài dự toán
    over_budget_qty REAL DEFAULT 0,             -- Số lượng vượt định mức dự toán (nếu có)
    unit_price REAL DEFAULT 0,                  -- Đơn giá dự toán tham chiếu (VNĐ)
    actual_unit_price REAL DEFAULT 0,           -- Đơn giá thực tế theo MISA/Hóa đơn (VNĐ)
    actual_total_cost REAL DEFAULT 0,           -- Thành tiền thực chi (VNĐ)
    khcn_approval_status TEXT DEFAULT 'PENDING',-- PENDING, APPROVED, FLAGGED, REJECTED
    khcn_approved_by TEXT,                      -- Cán bộ P. KH&CN duyệt đối chiếu
    khcn_approved_at TEXT,                      -- Thời gian duyệt đối chiếu
    stock_status TEXT DEFAULT 'Trong kho',      -- Chưa kiểm kho, Trong kho, Cần mua, Mua ngoài, Thầy Phúc duyệt
    received_quantity REAL DEFAULT 0,           -- Số lượng hàng đã nhận
    remaining_quantity REAL DEFAULT 0,          -- Số lượng hàng còn thiếu
    fulfillment_status TEXT DEFAULT 'Chưa nhận đủ', -- Đã nhận đủ, Chưa nhận đủ, Chưa cấp
    purchasing_status TEXT,                     -- Tình trạng mua hàng (lần 1 / lần 2)
    receiver_name TEXT,                         -- NCV nhận hàng
    received_date TEXT,                         -- Ngày nhận hàng
    pi_confirmed_received INTEGER DEFAULT 0,    -- Chủ nhiệm xác nhận đã nhận hàng (0/1)
    pi_confirmed_at TEXT,                       -- Thời điểm Chủ nhiệm xác nhận
    misa_order_id TEXT,                         -- Mã / ID đơn hàng MISA
    misa_link TEXT,                             -- Link hóa đơn / đơn hàng MISA
    proof_file_path TEXT,                       -- File minh chứng / phiếu giao nhận
    notes TEXT,                                 -- Ghi chú của P. KHCN
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES nckh_projects(id) ON DELETE CASCADE
);

-- 8. Hồ sơ Lý lịch Khoa học Điện tử (e-CV Nhà khoa học)
CREATE TABLE IF NOT EXISTS nckh_researchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT UNIQUE NOT NULL,
    academic_title TEXT,                        -- PGS.TS., TS., ThS., CN...
    email TEXT,
    phone TEXT,
    research_group TEXT,
    position_title TEXT,
    orcid TEXT,
    google_scholar_url TEXT,
    scopus_id TEXT,
    specialization TEXT,
    education_history TEXT,
    work_history TEXT,
    awards TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 9. Phiếu Chấm điểm Hội đồng Khoa học Trực tuyến (Xét duyệt Đề xuất & Nghiệm thu Đề tài)
CREATE TABLE IF NOT EXISTS nckh_council_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,                  -- PROPOSAL hoặc PROJECT
    target_id INTEGER NOT NULL,
    member_name TEXT NOT NULL,
    member_role TEXT NOT NULL,                  -- CHU_TICH, PHAN_BIEN_1, PHAN_BIEN_2, THU_KY, UY_VIEN
    score_scientific REAL DEFAULT 0,            -- Tính khoa học & mới mẻ (0-30)
    score_methodology REAL DEFAULT 0,           -- Phương pháp & khả thi (0-30)
    score_impact REAL DEFAULT 0,                -- Sản phẩm & ứng dụng (0-25)
    score_budget REAL DEFAULT 0,                -- Hợp lý dự toán / tiến độ (0-15)
    total_score REAL DEFAULT 0,                 -- Tổng điểm (0-100)
    vote TEXT DEFAULT 'DAT',                    -- DAT, DAT_CHINH_SUA, KHONG_DAT
    comments TEXT,
    submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_type, target_id, member_name)
);

-- =========================================================================
-- QUẢN LÝ ĐỢT KÊU GỌI ĐỀ TÀI, NỘP HỒ SƠ CUỐN CHIẾU & EMAIL THÔNG BÁO
-- =========================================================================

-- 1. Bảng Quản lý Đợt Kêu gọi Đề tài (Mở thường xuyên / Đóng khi dừng tổ chức)
CREATE TABLE IF NOT EXISTS nckh_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_code TEXT UNIQUE NOT NULL,             -- Mã đợt: DOT-2025.01, DOT-THUONG-XUYEN-2025...
    title TEXT NOT NULL,                        -- Tiêu đề đợt: Kêu gọi Đề xuất Đề tài NCKH Cấp Viện năm 2025...
    year INTEGER NOT NULL DEFAULT 2025,
    open_date TEXT NOT NULL,                    -- Ngày mở tiếp nhận hồ sơ
    deadline_date TEXT,                         -- Deadline đợt (nếu có, hoặc NULL nếu nhận liên tục)
    budget_limit_per_project REAL DEFAULT 0,    -- Định mức kinh phí tối đa mỗi đề tài (VNĐ)
    guidelines TEXT,                            -- Hướng dẫn, điều kiện nộp hồ sơ, mục tiêu định hướng của Viện
    is_active INTEGER DEFAULT 1,                -- 1: Đang mở nhận hồ sơ liên tục, 0: Đóng lại khi Viện không tổ chức nữa
    close_reason TEXT,                          -- Lý do đóng đợt (khi Viện dừng tổ chức)
    closed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 2. Bảng Hồ sơ Đề xuất NCKH Nộp theo Cơ chế Cuốn chiếu (Nộp lúc nào -> Xử lý quy trình ngay lúc đó)
CREATE TABLE IF NOT EXISTS nckh_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id INTEGER NOT NULL,                   -- Thuộc đợt kêu gọi nào
    proposal_code TEXT UNIQUE NOT NULL,         -- Mã hồ sơ tự động: DX-2025.001...
    title TEXT NOT NULL,                        -- Tên đề tài đề xuất
    leader_name TEXT NOT NULL,                  -- Chủ nhiệm đề xuất
    leader_email TEXT,                          -- Email Chủ nhiệm nhận thông báo
    research_group TEXT,                        -- Phân nhóm nghiên cứu
    members TEXT,                               -- Thành viên tham gia
    duration_months INTEGER DEFAULT 12,         -- Thời gian thực hiện dự kiến
    budget_proposed REAL DEFAULT 0,             -- Dự toán kinh phí đề xuất (VNĐ)
    summary_target TEXT,                        -- Tóm tắt mục tiêu & sản phẩm dự kiến
    status TEXT DEFAULT 'SUBMITTED',            -- SUBMITTED (Đã nộp), KHCN_VERIFIED (P.KHCN sơ duyệt), COUNCIL_REVIEW (Hội đồng xét duyệt), APPROVED (Viện trưởng duyệt trúng tuyển), REVISION_NEEDED (Yêu cầu bổ sung), REJECTED (Không duyệt)
    submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    khcn_notes TEXT,                            -- Ý kiến thẩm định ban đầu của P. KHCN
    khcn_verified_at TEXT,
    council_date TEXT,                          -- Ngày họp Hội đồng xét duyệt
    council_score REAL,                         -- Điểm trung bình Hội đồng
    council_result TEXT,                        -- Đạt / Đạt có chỉnh sửa / Không đạt
    council_notes TEXT,                         -- Nhận xét của Hội đồng
    director_decision TEXT,                     -- Ý kiến Viện trưởng
    director_approved_at TEXT,
    converted_project_id INTEGER,               -- ID đề tài chính thức được sinh ra sau khi duyệt trúng tuyển
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (call_id) REFERENCES nckh_calls(id) ON DELETE CASCADE,
    FOREIGN KEY (converted_project_id) REFERENCES nckh_projects(id) ON DELETE SET NULL
);

-- 3. File đính kèm Thuyết minh, Dự toán của Hồ sơ Đề xuất
CREATE TABLE IF NOT EXISTS nckh_proposal_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    file_type TEXT NOT NULL,                    -- THUYET_MINH, DU_TOAN, LY_LICH_KH, KHAC
    file_name TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    file_size INTEGER,
    uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proposal_id) REFERENCES nckh_proposals(id) ON DELETE CASCADE
);

-- 4. Bảng Nhật ký Email Tự động & Nhắc việc Đa kênh theo Ma trận Phân quyền
CREATE TABLE IF NOT EXISTS nckh_email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,                   -- CALL_OPEN, PROPOSAL_SUBMITTED, KHCN_VERIFIED, COUNCIL_SCHEDULED, DIRECTOR_APPROVED, REVISION_REQUESTED, DEADLINE_ALERT
    recipient_email TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    recipient_role TEXT NOT NULL,               -- CHU_NHIEM, PHONG_KHCN, VIEN_TRUONG, PHONG_TC_CU...
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,
    related_proposal_id INTEGER,
    related_project_id INTEGER,
    action_url TEXT,                            -- Đường link 1-Click dẫn thẳng vào màn hình xử lý của vai trò
    sent_status TEXT DEFAULT 'SENT',            -- SENT, SIMULATED, FAILED
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 5. Bảng Nhật ký Hoạt động Nghiệp vụ Hệ thống (Audit Trail cho Viện trưởng & Thanh tra)
CREATE TABLE IF NOT EXISTS nckh_activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_name TEXT NOT NULL,                   -- Tên người thực hiện (hoặc SYSTEM)
    actor_role TEXT NOT NULL,                   -- Vai trò: VIEN_TRUONG, PHONG_KHCN, CHU_NHIEM, SYSTEM...
    action TEXT NOT NULL,                       -- Mã hành động: SUBMIT_EXTENSION, APPROVE_EXTENSION, SUBMIT_REPORT, ADJUST_BUDGET, EXPORT_DOC, DEADLINE_SCAN...
    entity_type TEXT NOT NULL,                  -- PROJECT, PROPOSAL, EXTENSION, REPORT, BUDGET_ADJUSTMENT, DOCUMENT, CALL, AUDIT, SYSTEM
    entity_id INTEGER,                          -- ID bản ghi đối tượng
    project_id INTEGER,                         -- ID đề tài liên quan (nếu có)
    summary TEXT NOT NULL,                      -- Mô tả ngắn gọn tiếng Việt
    details TEXT,                               -- JSON chi tiết bổ sung
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_project ON nckh_activity_logs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON nckh_activity_logs(created_at DESC);

-- 6. Kho Sản phẩm KHCN có cấu trúc (Bài báo, Sáng chế/GPHI, Đào tạo, Sản phẩm khác)
CREATE TABLE IF NOT EXISTS nckh_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    product_type TEXT NOT NULL,                 -- PAPER, PATENT, TRAINING, OTHER
    title TEXT NOT NULL,                        -- Tên bài báo / sáng chế / luận văn
    authors_or_trainee TEXT,                    -- Nhóm tác giả hoặc Học viên/NCS
    venue_or_degree TEXT,                       -- Tên tạp chí / Cơ quan cấp / Bậc đào tạo (ThS, TS, CN)
    quartile_or_rank TEXT,                      -- Q1, Q2, Q3, Q4, Scopus, ISI, Trong nước, Độc quyền, GPHI...
    doi_or_code TEXT,                           -- DOI / ISSN / Số đơn / Số bằng / Số QĐ
    publish_year INTEGER,                       -- Năm công bố / cấp bằng / bảo vệ
    status TEXT DEFAULT 'REGISTERED',           -- REGISTERED, SUBMITTED, ACCEPTED, PUBLISHED
    evidence_file_id INTEGER,
    notes TEXT,
    verified_by TEXT,
    verified_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES nckh_projects(id) ON DELETE CASCADE
);

-- 8. Hồ sơ Lý lịch Khoa học Điện tử (e-CV Nhà khoa học)
CREATE TABLE IF NOT EXISTS nckh_researchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT UNIQUE NOT NULL,
    academic_title TEXT,                        -- PGS.TS., TS., ThS., CN...
    email TEXT,
    phone TEXT,
    research_group TEXT,
    position_title TEXT,
    orcid TEXT,
    google_scholar_url TEXT,
    scopus_id TEXT,
    specialization TEXT,
    education_history TEXT,
    work_history TEXT,
    awards TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 9. Phiếu Chấm điểm Hội đồng Khoa học Trực tuyến (Xét duyệt Đề xuất & Nghiệm thu Đề tài)
CREATE TABLE IF NOT EXISTS nckh_council_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,                  -- PROPOSAL hoặc PROJECT
    target_id INTEGER NOT NULL,
    member_name TEXT NOT NULL,
    member_role TEXT NOT NULL,                  -- CHU_TICH, PHAN_BIEN_1, PHAN_BIEN_2, THU_KY, UY_VIEN
    score_scientific REAL DEFAULT 0,            -- Tính khoa học & mới mẻ (0-30)
    score_methodology REAL DEFAULT 0,           -- Phương pháp & khả thi (0-30)
    score_impact REAL DEFAULT 0,                -- Sản phẩm & ứng dụng (0-25)
    score_budget REAL DEFAULT 0,                -- Hợp lý dự toán / tiến độ (0-15)
    total_score REAL DEFAULT 0,                 -- Tổng điểm (0-100)
    vote TEXT DEFAULT 'DAT',                    -- DAT, DAT_CHINH_SUA, KHONG_DAT
    comments TEXT,
    submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_type, target_id, member_name)
);

CREATE INDEX IF NOT EXISTS idx_products_project ON nckh_products(project_id);

-- 7. Hồ sơ Luồng Nghiệm thu - Thanh lý Khép kín
CREATE TABLE IF NOT EXISTS nckh_acceptances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL UNIQUE,
    stage_status TEXT DEFAULT 'DRAFT',          -- REQUESTED, KHCN_CHECKED, COUNCIL_SCHEDULED, COUNCIL_EVALUATED, REVISION_SUBMITTED, RECOGNIZED, LIQUIDATED, CANCELLED_LIQUIDATION
    request_date TEXT,
    requested_by TEXT,
    khcn_checked_by TEXT,
    khcn_checked_at TEXT,
    khcn_notes TEXT,
    council_date TEXT,
    council_location TEXT,
    council_chair TEXT,
    council_members TEXT,
    council_score REAL,
    council_rating TEXT,                        -- Xuất sắc, Tốt, Khá, Đạt, Không đạt
    council_conclusion TEXT,
    revision_summary TEXT,
    revision_submitted_at TEXT,
    recognition_decision_number TEXT,
    recognition_decision_date TEXT,
    liquidation_date TEXT,
    liquidation_settled_amount REAL DEFAULT 0,
    liquidation_refund_amount REAL DEFAULT 0,
    liquidation_notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES nckh_projects(id) ON DELETE CASCADE
);

-- 8. Hồ sơ Lý lịch Khoa học Điện tử (e-CV Nhà khoa học)
CREATE TABLE IF NOT EXISTS nckh_researchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT UNIQUE NOT NULL,
    academic_title TEXT,                        -- PGS.TS., TS., ThS., CN...
    email TEXT,
    phone TEXT,
    research_group TEXT,
    position_title TEXT,
    orcid TEXT,
    google_scholar_url TEXT,
    scopus_id TEXT,
    specialization TEXT,
    education_history TEXT,
    work_history TEXT,
    awards TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 9. Phiếu Chấm điểm Hội đồng Khoa học Trực tuyến (Xét duyệt Đề xuất & Nghiệm thu Đề tài)
CREATE TABLE IF NOT EXISTS nckh_council_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,                  -- PROPOSAL hoặc PROJECT
    target_id INTEGER NOT NULL,
    member_name TEXT NOT NULL,
    member_role TEXT NOT NULL,                  -- CHU_TICH, PHAN_BIEN_1, PHAN_BIEN_2, THU_KY, UY_VIEN
    score_scientific REAL DEFAULT 0,            -- Tính khoa học & mới mẻ (0-30)
    score_methodology REAL DEFAULT 0,           -- Phương pháp & khả thi (0-30)
    score_impact REAL DEFAULT 0,                -- Sản phẩm & ứng dụng (0-25)
    score_budget REAL DEFAULT 0,                -- Hợp lý dự toán / tiến độ (0-15)
    total_score REAL DEFAULT 0,                 -- Tổng điểm (0-100)
    vote TEXT DEFAULT 'DAT',                    -- DAT, DAT_CHINH_SUA, KHONG_DAT
    comments TEXT,
    submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_type, target_id, member_name)
);

CREATE TABLE IF NOT EXISTS nckh_audit_checklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    doc_key TEXT NOT NULL,                      -- THUYET_MINH, BB_XET_DUYET, QD_GIAO_NHIEM_VU, HOP_DONG_NCKH, DU_TOAN_DA_DUYET, CHUNG_TU_VAT_TU, BAO_CAO_6_THANG, QD_GIA_HAN, BAO_CAO_TONG_KET, SAN_PHAM_KHCN, BB_NGHIEM_THU, GIAI_TRINH_SAU_HOP, QD_CONG_NHAN, BB_THANH_LY
    status TEXT DEFAULT 'MISSING',              -- VERIFIED, UPLOADED, MISSING, WAIVED
    verified_by TEXT,                           -- Cán bộ thẩm định
    verified_at TEXT,                           -- Ngày thẩm định
    notes TEXT,                                 -- Ghi chú hồ sơ phục vụ thanh tra kiểm toán
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES nckh_projects(id) ON DELETE CASCADE,
    UNIQUE(project_id, doc_key)
);

CREATE TABLE IF NOT EXISTS nckh_budget_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    adjustment_num INTEGER DEFAULT 1,           -- Lần điều chỉnh (1, 2...)
    old_budget REAL NOT NULL,                   -- Kinh phí trước khi điều chỉnh (VNĐ)
    new_budget REAL NOT NULL,                   -- Kinh phí mới đề xuất / được duyệt (VNĐ)
    difference_amount REAL NOT NULL,            -- Chênh lệch (+ tăng / - giảm)
    reason TEXT NOT NULL,                       -- Lý do điều chỉnh (thay đổi chủng loại hóa chất, biến động giá, điều chuyển mục chi...)
    proposal_details TEXT,                      -- Bảng chi tiết các hạng mục thay đổi (JSON hoặc Text)
    request_date TEXT NOT NULL,                 -- Ngày Chủ nhiệm nộp tờ trình
    status TEXT DEFAULT 'PENDING',              -- PENDING (Chờ duyệt), KHCN_REVIEWED (P. KHCN đã thẩm tra), APPROVED (Viện trưởng đã ký), REJECTED (Từ chối)
    khcn_opinion TEXT,                          -- Ý kiến thẩm tra chuyên môn của P. KHCN
    khcn_reviewed_by TEXT,                      -- Chuyên viên P. KHCN thẩm tra
    khcn_reviewed_at TEXT,                      -- Thời gian P. KHCN thẩm tra
    director_decision TEXT,                     -- Ý kiến / Bút phê của Viện trưởng
    decision_number TEXT,                       -- Số Quyết định hoặc Phụ lục HĐ điều chỉnh dự toán
    decision_date TEXT,                         -- Ngày ký Quyết định điều chỉnh
    approved_by TEXT,                           -- Người ký (Viện trưởng)
    approved_at TEXT,                           -- Ngày giờ phê duyệt
    request_file_id INTEGER,                    -- File Tờ trình / Đơn xin điều chỉnh (nckh_documents)
    decision_file_id INTEGER,                   -- File Quyết định phê duyệt điều chỉnh (nckh_documents)
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES nckh_projects(id) ON DELETE CASCADE
);

-- 8. Hồ sơ Lý lịch Khoa học Điện tử (e-CV Nhà khoa học)
CREATE TABLE IF NOT EXISTS nckh_researchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT UNIQUE NOT NULL,
    academic_title TEXT,                        -- PGS.TS., TS., ThS., CN...
    email TEXT,
    phone TEXT,
    research_group TEXT,
    position_title TEXT,
    orcid TEXT,
    google_scholar_url TEXT,
    scopus_id TEXT,
    specialization TEXT,
    education_history TEXT,
    work_history TEXT,
    awards TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 9. Phiếu Chấm điểm Hội đồng Khoa học Trực tuyến (Xét duyệt Đề xuất & Nghiệm thu Đề tài)
CREATE TABLE IF NOT EXISTS nckh_council_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,                  -- PROPOSAL hoặc PROJECT
    target_id INTEGER NOT NULL,
    member_name TEXT NOT NULL,
    member_role TEXT NOT NULL,                  -- CHU_TICH, PHAN_BIEN_1, PHAN_BIEN_2, THU_KY, UY_VIEN
    score_scientific REAL DEFAULT 0,            -- Tính khoa học & mới mẻ (0-30)
    score_methodology REAL DEFAULT 0,           -- Phương pháp & khả thi (0-30)
    score_impact REAL DEFAULT 0,                -- Sản phẩm & ứng dụng (0-25)
    score_budget REAL DEFAULT 0,                -- Hợp lý dự toán / tiến độ (0-15)
    total_score REAL DEFAULT 0,                 -- Tổng điểm (0-100)
    vote TEXT DEFAULT 'DAT',                    -- DAT, DAT_CHINH_SUA, KHONG_DAT
    comments TEXT,
    submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_type, target_id, member_name)
);

-- =========================================================================
-- QUẢN LÝ ĐỢT KÊU GỌI ĐỀ TÀI, NỘP HỒ SƠ CUỐN CHIẾU & EMAIL THÔNG BÁO
-- =========================================================================

-- 1. Bảng Quản lý Đợt Kêu gọi Đề tài (Mở thường xuyên / Đóng khi dừng tổ chức)
CREATE TABLE IF NOT EXISTS nckh_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_code TEXT UNIQUE NOT NULL,             -- Mã đợt: DOT-2025.01, DOT-THUONG-XUYEN-2025...
    title TEXT NOT NULL,                        -- Tiêu đề đợt: Kêu gọi Đề xuất Đề tài NCKH Cấp Viện năm 2025...
    year INTEGER NOT NULL DEFAULT 2025,
    open_date TEXT NOT NULL,                    -- Ngày mở tiếp nhận hồ sơ
    deadline_date TEXT,                         -- Deadline đợt (nếu có, hoặc NULL nếu nhận liên tục)
    budget_limit_per_project REAL DEFAULT 0,    -- Định mức kinh phí tối đa mỗi đề tài (VNĐ)
    guidelines TEXT,                            -- Hướng dẫn, điều kiện nộp hồ sơ, mục tiêu định hướng của Viện
    is_active INTEGER DEFAULT 1,                -- 1: Đang mở nhận hồ sơ liên tục, 0: Đóng lại khi Viện không tổ chức nữa
    close_reason TEXT,                          -- Lý do đóng đợt (khi Viện dừng tổ chức)
    closed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 2. Bảng Hồ sơ Đề xuất NCKH Nộp theo Cơ chế Cuốn chiếu (Nộp lúc nào -> Xử lý quy trình ngay lúc đó)
CREATE TABLE IF NOT EXISTS nckh_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id INTEGER NOT NULL,                   -- Thuộc đợt kêu gọi nào
    proposal_code TEXT UNIQUE NOT NULL,         -- Mã hồ sơ tự động: DX-2025.001...
    title TEXT NOT NULL,                        -- Tên đề tài đề xuất
    leader_name TEXT NOT NULL,                  -- Chủ nhiệm đề xuất
    leader_email TEXT,                          -- Email Chủ nhiệm nhận thông báo
    research_group TEXT,                        -- Phân nhóm nghiên cứu
    members TEXT,                               -- Thành viên tham gia
    duration_months INTEGER DEFAULT 12,         -- Thời gian thực hiện dự kiến
    budget_proposed REAL DEFAULT 0,             -- Dự toán kinh phí đề xuất (VNĐ)
    summary_target TEXT,                        -- Tóm tắt mục tiêu & sản phẩm dự kiến
    status TEXT DEFAULT 'SUBMITTED',            -- SUBMITTED (Đã nộp), KHCN_VERIFIED (P.KHCN sơ duyệt), COUNCIL_REVIEW (Hội đồng xét duyệt), APPROVED (Viện trưởng duyệt trúng tuyển), REVISION_NEEDED (Yêu cầu bổ sung), REJECTED (Không duyệt)
    submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    khcn_notes TEXT,                            -- Ý kiến thẩm định ban đầu của P. KHCN
    khcn_verified_at TEXT,
    council_date TEXT,                          -- Ngày họp Hội đồng xét duyệt
    council_score REAL,                         -- Điểm trung bình Hội đồng
    council_result TEXT,                        -- Đạt / Đạt có chỉnh sửa / Không đạt
    council_notes TEXT,                         -- Nhận xét của Hội đồng
    director_decision TEXT,                     -- Ý kiến Viện trưởng
    director_approved_at TEXT,
    converted_project_id INTEGER,               -- ID đề tài chính thức được sinh ra sau khi duyệt trúng tuyển
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (call_id) REFERENCES nckh_calls(id) ON DELETE CASCADE,
    FOREIGN KEY (converted_project_id) REFERENCES nckh_projects(id) ON DELETE SET NULL
);

-- 3. File đính kèm Thuyết minh, Dự toán của Hồ sơ Đề xuất
CREATE TABLE IF NOT EXISTS nckh_proposal_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    file_type TEXT NOT NULL,                    -- THUYET_MINH, DU_TOAN, LY_LICH_KH, KHAC
    file_name TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    file_size INTEGER,
    uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proposal_id) REFERENCES nckh_proposals(id) ON DELETE CASCADE
);

-- 4. Bảng Nhật ký Email Tự động & Nhắc việc Đa kênh theo Ma trận Phân quyền
CREATE TABLE IF NOT EXISTS nckh_email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,                   -- CALL_OPEN, PROPOSAL_SUBMITTED, KHCN_VERIFIED, COUNCIL_SCHEDULED, DIRECTOR_APPROVED, REVISION_REQUESTED, DEADLINE_ALERT
    recipient_email TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    recipient_role TEXT NOT NULL,               -- CHU_NHIEM, PHONG_KHCN, VIEN_TRUONG, PHONG_TC_CU...
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,
    related_proposal_id INTEGER,
    related_project_id INTEGER,
    action_url TEXT,                            -- Đường link 1-Click dẫn thẳng vào màn hình xử lý của vai trò
    sent_status TEXT DEFAULT 'SENT',            -- SENT, SIMULATED, FAILED
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 5. Bảng Nhật ký Hoạt động Nghiệp vụ Hệ thống (Audit Trail cho Viện trưởng & Thanh tra)
CREATE TABLE IF NOT EXISTS nckh_activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_name TEXT NOT NULL,                   -- Tên người thực hiện (hoặc SYSTEM)
    actor_role TEXT NOT NULL,                   -- Vai trò: VIEN_TRUONG, PHONG_KHCN, CHU_NHIEM, SYSTEM...
    action TEXT NOT NULL,                       -- Mã hành động: SUBMIT_EXTENSION, APPROVE_EXTENSION, SUBMIT_REPORT, ADJUST_BUDGET, EXPORT_DOC, DEADLINE_SCAN...
    entity_type TEXT NOT NULL,                  -- PROJECT, PROPOSAL, EXTENSION, REPORT, BUDGET_ADJUSTMENT, DOCUMENT, CALL, AUDIT, SYSTEM
    entity_id INTEGER,                          -- ID bản ghi đối tượng
    project_id INTEGER,                         -- ID đề tài liên quan (nếu có)
    summary TEXT NOT NULL,                      -- Mô tả ngắn gọn tiếng Việt
    details TEXT,                               -- JSON chi tiết bổ sung
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_project ON nckh_activity_logs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON nckh_activity_logs(created_at DESC);

-- 6. Kho Sản phẩm KHCN có cấu trúc (Bài báo, Sáng chế/GPHI, Đào tạo, Sản phẩm khác)
CREATE TABLE IF NOT EXISTS nckh_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    product_type TEXT NOT NULL,                 -- PAPER, PATENT, TRAINING, OTHER
    title TEXT NOT NULL,                        -- Tên bài báo / sáng chế / luận văn
    authors_or_trainee TEXT,                    -- Nhóm tác giả hoặc Học viên/NCS
    venue_or_degree TEXT,                       -- Tên tạp chí / Cơ quan cấp / Bậc đào tạo (ThS, TS, CN)
    quartile_or_rank TEXT,                      -- Q1, Q2, Q3, Q4, Scopus, ISI, Trong nước, Độc quyền, GPHI...
    doi_or_code TEXT,                           -- DOI / ISSN / Số đơn / Số bằng / Số QĐ
    publish_year INTEGER,                       -- Năm công bố / cấp bằng / bảo vệ
    status TEXT DEFAULT 'REGISTERED',           -- REGISTERED, SUBMITTED, ACCEPTED, PUBLISHED
    evidence_file_id INTEGER,
    notes TEXT,
    verified_by TEXT,
    verified_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES nckh_projects(id) ON DELETE CASCADE
);

-- 8. Hồ sơ Lý lịch Khoa học Điện tử (e-CV Nhà khoa học)
CREATE TABLE IF NOT EXISTS nckh_researchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT UNIQUE NOT NULL,
    academic_title TEXT,                        -- PGS.TS., TS., ThS., CN...
    email TEXT,
    phone TEXT,
    research_group TEXT,
    position_title TEXT,
    orcid TEXT,
    google_scholar_url TEXT,
    scopus_id TEXT,
    specialization TEXT,
    education_history TEXT,
    work_history TEXT,
    awards TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 9. Phiếu Chấm điểm Hội đồng Khoa học Trực tuyến (Xét duyệt Đề xuất & Nghiệm thu Đề tài)
CREATE TABLE IF NOT EXISTS nckh_council_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,                  -- PROPOSAL hoặc PROJECT
    target_id INTEGER NOT NULL,
    member_name TEXT NOT NULL,
    member_role TEXT NOT NULL,                  -- CHU_TICH, PHAN_BIEN_1, PHAN_BIEN_2, THU_KY, UY_VIEN
    score_scientific REAL DEFAULT 0,            -- Tính khoa học & mới mẻ (0-30)
    score_methodology REAL DEFAULT 0,           -- Phương pháp & khả thi (0-30)
    score_impact REAL DEFAULT 0,                -- Sản phẩm & ứng dụng (0-25)
    score_budget REAL DEFAULT 0,                -- Hợp lý dự toán / tiến độ (0-15)
    total_score REAL DEFAULT 0,                 -- Tổng điểm (0-100)
    vote TEXT DEFAULT 'DAT',                    -- DAT, DAT_CHINH_SUA, KHONG_DAT
    comments TEXT,
    submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_type, target_id, member_name)
);

CREATE INDEX IF NOT EXISTS idx_products_project ON nckh_products(project_id);

-- 7. Hồ sơ Luồng Nghiệm thu - Thanh lý Khép kín
CREATE TABLE IF NOT EXISTS nckh_acceptances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL UNIQUE,
    stage_status TEXT DEFAULT 'DRAFT',          -- REQUESTED, KHCN_CHECKED, COUNCIL_SCHEDULED, COUNCIL_EVALUATED, REVISION_SUBMITTED, RECOGNIZED, LIQUIDATED, CANCELLED_LIQUIDATION
    request_date TEXT,
    requested_by TEXT,
    khcn_checked_by TEXT,
    khcn_checked_at TEXT,
    khcn_notes TEXT,
    council_date TEXT,
    council_location TEXT,
    council_chair TEXT,
    council_members TEXT,
    council_score REAL,
    council_rating TEXT,                        -- Xuất sắc, Tốt, Khá, Đạt, Không đạt
    council_conclusion TEXT,
    revision_summary TEXT,
    revision_submitted_at TEXT,
    recognition_decision_number TEXT,
    recognition_decision_date TEXT,
    liquidation_date TEXT,
    liquidation_settled_amount REAL DEFAULT 0,
    liquidation_refund_amount REAL DEFAULT 0,
    liquidation_notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES nckh_projects(id) ON DELETE CASCADE
);

-- 8. Hồ sơ Lý lịch Khoa học Điện tử (e-CV Nhà khoa học)
CREATE TABLE IF NOT EXISTS nckh_researchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT UNIQUE NOT NULL,
    academic_title TEXT,                        -- PGS.TS., TS., ThS., CN...
    email TEXT,
    phone TEXT,
    research_group TEXT,
    position_title TEXT,
    orcid TEXT,
    google_scholar_url TEXT,
    scopus_id TEXT,
    specialization TEXT,
    education_history TEXT,
    work_history TEXT,
    awards TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 9. Phiếu Chấm điểm Hội đồng Khoa học Trực tuyến (Xét duyệt Đề xuất & Nghiệm thu Đề tài)
CREATE TABLE IF NOT EXISTS nckh_council_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,                  -- PROPOSAL hoặc PROJECT
    target_id INTEGER NOT NULL,
    member_name TEXT NOT NULL,
    member_role TEXT NOT NULL,                  -- CHU_TICH, PHAN_BIEN_1, PHAN_BIEN_2, THU_KY, UY_VIEN
    score_scientific REAL DEFAULT 0,            -- Tính khoa học & mới mẻ (0-30)
    score_methodology REAL DEFAULT 0,           -- Phương pháp & khả thi (0-30)
    score_impact REAL DEFAULT 0,                -- Sản phẩm & ứng dụng (0-25)
    score_budget REAL DEFAULT 0,                -- Hợp lý dự toán / tiến độ (0-15)
    total_score REAL DEFAULT 0,                 -- Tổng điểm (0-100)
    vote TEXT DEFAULT 'DAT',                    -- DAT, DAT_CHINH_SUA, KHONG_DAT
    comments TEXT,
    submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_type, target_id, member_name)
);
