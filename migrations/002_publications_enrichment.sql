-- Bổ sung cột enrichment / phân hạng tạp chí cho bảng publications.
-- SQLite không có ADD COLUMN IF NOT EXISTS: nếu cột đã tồn tại, lệnh ALTER sẽ lỗi — bỏ qua khi chạy tay.
-- Ứng dụng tự thêm cột an toàn qua ensureSQLiteCompatibility() trong sci-khcn-publications/src/db/index.js

-- quartile: thường đã có sẵn từ module publications — không ALTER lại.

ALTER TABLE publications ADD COLUMN issn_resolved TEXT;
ALTER TABLE publications ADD COLUMN issn_source TEXT;
ALTER TABLE publications ADD COLUMN sjr_score REAL;
ALTER TABLE publications ADD COLUMN sjr_year_used INTEGER;
ALTER TABLE publications ADD COLUMN jcr_if REAL;
ALTER TABLE publications ADD COLUMN openalex_cite_count INTEGER;
ALTER TABLE publications ADD COLUMN enrichment_status TEXT DEFAULT 'pending';
ALTER TABLE publications ADD COLUMN enrichment_note TEXT;
ALTER TABLE publications ADD COLUMN enriched_at TEXT;
