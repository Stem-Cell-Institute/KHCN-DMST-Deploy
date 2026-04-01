# Hướng dẫn tích hợp vào Cursor — SCI-KHCN Publications Backend

## Cấu trúc thư mục
```
sci-khcn-publications/
├── src/
│   ├── app.js                    ← Entry point Express
│   ├── db/
│   │   └── index.js              ← Schema + getDB() / initDB()
│   ├── routes/
│   │   ├── publications.js       ← CRUD /api/publications
│   │   ├── orcid.js              ← ORCID harvest + queue /api/orcid
│   │   └── doi.js                ← DOI fetch /api/doi
│   ├── services/
│   │   ├── doiService.js         ← Crossref + PubMed + Unpaywall pipeline
│   │   └── orcidService.js       ← ORCID harvest + DB helpers
│   ├── middleware/
│   │   └── errorHandler.js
│   └── api-client.js             ← Dán vào <script> của trang HTML
├── data/                         ← (auto-created) SQLite file dev
├── package.json
└── .env.example → .env
```

---

## Bước 1 — Cài đặt
```bash
cd sci-khcn-publications
npm install
cp .env.example .env
# Điền CROSSREF_POLITE_EMAIL=khcn@sci.edu.vn (và DATABASE_URL nếu prod)
npm run db:init   # Tạo schema SQLite
npm run dev       # Chạy với hot-reload
```

---

## Bước 2 — Tích hợp vào codebase chính

### Nếu project dùng Express monolith
```js
// Trong app.js chính của bạn, thêm:
import { publicationsRouter } from './modules/publications/routes/publications.js';
import { orcidRouter }        from './modules/publications/routes/orcid.js';
import { doiRouter }          from './modules/publications/routes/doi.js';

app.use('/api/publications', publicationsRouter);
app.use('/api/orcid',        orcidRouter);
app.use('/api/doi',          doiRouter);
```

### Nếu project dùng SQLite pool khác
```js
// Trong src/db/index.js, sửa hàm getDB():
import { yourExistingDBPool } from '../../db.js';  // ← path thực
export async function getDB() { return yourExistingDBPool; }
// Xóa phần better-sqlite3 init, thêm db.__isSQLite = true nếu là SQLite
```

### Nếu project dùng Neon đã có pool
```js
// Trong src/db/index.js:
import { neonPool } from '../../db/neon.js';  // pool hiện có
export async function getDB() { return neonPool; }
// Bỏ toàn bộ phần IS_PROD check
```

---

## Bước 3 — Kết nối trang HTML

### Cách A: Thêm script tag vào cong-bo-khoa-hoc.html
```html
<!-- Trước </body> — sau script mock data hiện tại -->
<script type="module">
  // Ghi đè BASE_URL nếu cần
  window.SCI_API_URL = '/api';   // hoặc 'http://localhost:3001/api' khi dev
</script>
<script type="module" src="/js/api-client.js"></script>
```

### Cách B: Bundle vào Vite/Webpack
```js
// Trong main.js của bạn:
import './api-client.js';
```

---

## API Endpoints hoàn chỉnh

### Publications CRUD
| Method | Path | Mô tả |
|--------|------|-------|
| GET | /api/publications | Danh sách (filter: q, year, pub_type, quartile, status, index_db) |
| GET | /api/publications/stats | Thống kê dashboard |
| GET | /api/publications/:id | Chi tiết |
| POST | /api/publications | Tạo mới thủ công |
| PUT | /api/publications/:id | Cập nhật |
| DELETE | /api/publications/:id | Xóa |

### DOI Fetch
| Method | Path | Mô tả |
|--------|------|-------|
| POST | /api/doi/fetch | Body: {doi} → trả metadata đầy đủ từ Crossref+PubMed |

### ORCID Harvest
| Method | Path | Mô tả |
|--------|------|-------|
| GET | /api/orcid/researchers | Danh sách NCV có ORCID |
| POST | /api/orcid/researchers | Thêm/cập nhật NCV |
| DELETE | /api/orcid/researchers/:id | Xóa NCV |
| GET | /api/orcid/harvest/stream | **SSE** — harvest real-time |
| POST | /api/orcid/harvest | Harvest không stream (fallback) |
| GET | /api/orcid/queue?status=pending | Queue chờ duyệt |
| POST | /api/orcid/queue/:id/approve | Duyệt 1 item |
| POST | /api/orcid/queue/:id/reject | Từ chối 1 item |
| POST | /api/orcid/queue/approve-all | Import tất cả pending |

---

## Luồng ORCID Harvest (sequence)
```
Browser          Backend          ORCID API        Crossref API
   │                │                  │                 │
   │──GET /harvest/stream──►           │                 │
   │◄──SSE: session_start──            │                 │
   │                │──GET /{orcid}/works──►             │
   │                │◄──200 JSON (works list)──          │
   │◄──SSE: researcher_start──         │                 │
   │                │  (filter new DOIs)                  │
   │                │──GET /works/{doi}────────────────►  │
   │                │◄──200 metadata (title, authors…)──  │
   │                │  (insert into publication_queue)    │
   │◄──SSE: researcher_done (newItems)──                  │
   │                │  (repeat for each researcher)       │
   │◄──SSE: session_complete──         │                 │
   │──close EventSource──              │                 │
   │                │                  │                 │
   │──POST /queue/:id/approve──►        │                 │
   │                │  (move queue → publications)        │
   │◄──200 {ok:true}──                 │                 │
```

---

## API bên ngoài — tóm tắt chi phí

| API | Chi phí | Rate limit | Key cần? |
|-----|---------|-----------|---------|
| ORCID Public v3.0 | Miễn phí | 24 req/s | Không |
| Crossref Metadata | Miễn phí | Polite pool (email) | Không |
| PubMed E-utilities | Miễn phí | 3 req/s (10 với key) | Không |
| Unpaywall | Miễn phí | Polite pool (email) | Không |
| Scopus Abstract | Miễn phí (institutional) | 20k req/week | Cần xin qua ĐHQG |
| WoS Starter | Miễn phí | 5000 req/tháng | Cần đăng ký |

---

## Cursor prompts gợi ý

```
1. "Tích hợp publicationsRouter, orcidRouter, doiRouter vào app.js chính.
    Đảm bảo dùng chung DB pool SQLite hiện có, không tạo pool mới."

2. "Thêm JWT middleware vào orcidRouter — chỉ admin role mới được
    gọi /harvest/stream và /queue/:id/approve."

3. "Viết cron job chạy lúc 2:00 sáng mỗi thứ Hai, gọi runHarvestSession()
    và gửi email báo cáo tổng kết (số công bố mới) cho admin."

4. "Thêm endpoint GET /api/publications/export?format=excel
    dùng ExcelJS để xuất file .xlsx với tất cả fields."

5. "Viết test cho fetchAndEnrichDOI() dùng vitest, mock fetch
    với fixture data từ Crossref real response."
```
