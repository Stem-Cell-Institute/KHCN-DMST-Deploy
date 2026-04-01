-- =============================================================================
-- Thống kê công bố KHCN (SQLite) — khớp bảng publications trong sci-khcn-publications
-- Cột năm: pub_year (không có cột year). Trạng thái: chỉ status = 'published'.
-- Scopus/WoS/PubMed: suy từ index_db + scopus_eid / wos_id / pmid (khớp /api/publications/stats).
-- =============================================================================

-- Bảng phụ tác giả (điền khi import / pipeline — dùng cho top-authors)
CREATE TABLE IF NOT EXISTS publication_authors (
  publication_id INTEGER NOT NULL,
  author_name    TEXT NOT NULL,
  position       INTEGER,
  FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_publication_authors_name ON publication_authors(author_name);
CREATE INDEX IF NOT EXISTS idx_publication_authors_pub_id ON publication_authors(publication_id);

-- -----------------------------------------------------------------------------
-- A1. Sản lượng theo năm + YoY (API: GET /api/pub-analytics/yearly-output)
-- -----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_yearly_output AS
SELECT
  p.pub_year AS year,
  COUNT(*) AS total_papers,
  COUNT(*) - LAG(COUNT(*)) OVER (ORDER BY p.pub_year) AS yoy_change,
  ROUND(
    (COUNT(*) - LAG(COUNT(*)) OVER (ORDER BY p.pub_year)) * 100.0
    / NULLIF(LAG(COUNT(*)) OVER (ORDER BY p.pub_year), 0),
    1
  ) AS yoy_pct,
  SUM(p.citation_count) AS total_citations,
  ROUND(AVG(p.citation_count), 2) AS avg_citations_per_paper
FROM publications p
WHERE p.status = 'published'
  AND p.pub_year IS NOT NULL
GROUP BY p.pub_year;

-- -----------------------------------------------------------------------------
-- A2. Phân bố Q theo năm + điểm TT 26/2022 (API: quartile-distribution)
-- -----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_quartile_distribution AS
SELECT
  p.pub_year AS year,
  COUNT(*) AS total,
  SUM(CASE WHEN p.quartile = 'Q1' THEN 1 ELSE 0 END) AS q1,
  SUM(CASE WHEN p.quartile = 'Q2' THEN 1 ELSE 0 END) AS q2,
  SUM(CASE WHEN p.quartile = 'Q3' THEN 1 ELSE 0 END) AS q3,
  SUM(CASE WHEN p.quartile = 'Q4' THEN 1 ELSE 0 END) AS q4,
  ROUND(
    (SUM(CASE WHEN p.quartile IN ('Q1', 'Q2') THEN 1 ELSE 0 END)) * 100.0 / COUNT(*),
    1
  ) AS top_tier_pct,
  ROUND(
    SUM(
      CASE
        WHEN p.quartile = 'Q1' THEN 2.0
        WHEN p.quartile = 'Q2' THEN 1.5
        WHEN p.quartile = 'Q3' THEN 1.0
        WHEN p.quartile = 'Q4' THEN 0.75
        ELSE 0
      END
    ),
    2
  ) AS tt26_score
FROM publications p
WHERE p.status = 'published'
  AND p.pub_year IS NOT NULL
GROUP BY p.pub_year;

-- -----------------------------------------------------------------------------
-- Tham chiếu nhanh (chạy qua API có tham số — không tạo view):
--
-- A3 top-authors: JOIN publication_authors + publications, GROUP BY author_name
-- A4 kpi-snapshot: SELECT ... FROM publications WHERE status='published' AND pub_year=?
-- A4 top-journals: GROUP BY journal_name ORDER BY COUNT(*) DESC
-- A4 citations-ranking: ORDER BY citation_count DESC
-- A4 database-coverage: CASE trên index_db + scopus_eid/wos_id/pmid
-- -----------------------------------------------------------------------------
