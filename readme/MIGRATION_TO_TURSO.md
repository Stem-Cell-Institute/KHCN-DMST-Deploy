# Hướng Dẫn Chuyển Đổi Database Sang Turso

## Tổng Quan

Tài liệu này hướng dẫn cách chuyển đổi database từ SQLite sang **Turso** (libSQL) để:
- Hỗ trợ Cloudflare Workers/Pages
- Xử lý nhiều người đọc/ghi đồng thời
- Replication tự động cho đọc nhanh
- Free tier 9GB storage, 500 req/s

## Mục Lục

1. [Cài đặt công cụ](#1-cài-đặt-công-cụ)
2. [Tạo Database Turso](#2-tạo-database-turso)
3. [Cấu hình Environment](#3-cấu-hình-environment)
4. [Migration Dữ Liệu](#4-migration-dữ-liệu)
5. [Deploy lên Cloudflare](#5-deploy-lên-cloudflare)
6. [Xử lý Sự Cố](#6-xử-lý-sự-cố)

---

## 1. Cài Đặt Công Cụ

### 1.1 Cài Turso CLI

**macOS/Linux:**
```bash
curl -sSfL https://get.tur.so/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://get.tur.so/install.ps1 | iex
```

Hoặc sử dụng Scoop:
```bash
scoop install turso
```

### 1.2 Xác minh cài đặt
```bash
turso --version
```

### 1.3 Cài đặt Node.js dependencies mới
```bash
npm install
```

---

## 2. Tạo Database Turso

### 2.1 Đăng nhập Turso (nếu chưa có tài khoản)

```bash
turso auth login
```

Truy cập https://console.tur.so để tạo tài khoản miễn phí.

### 2.2 Tạo Database

```bash
turso db create sci-ace
```

### 2.3 Lấy thông tin kết nối

```bash
# Lấy URL database
turso db show sci-ace --url
# Output: libsql://sci-ace-xxxx.turso.io

# Tạo authentication token
turso db tokens create sci-ace
# Output: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## 3. Cấu Hình Environment

### 3.1 Sao chép file cấu hình

```bash
cp .env.example .env
```

### 3.2 Cập nhật `.env`

```env
# =============================================
# CẤU HÌNH DATABASE - CHẾ ĐỘ TURSO
# =============================================
DATABASE_URL=libsql://sci-ace-xxxx.turso.io
DATABASE_AUTH_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# =============================================
# SERVER
# =============================================
PORT=3000
BASE_URL=https://your-app.pages.dev

# =============================================
# JWT (thay đổi secret mới)
# =============================================
JWT_SECRET=your-super-secure-secret-here

# =============================================
# EMAIL
# =============================================
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=hethongquanlykhcn_dmst@sci.edu.vn
```

---

## 4. Migration Dữ Liệu

### 4.1 Kiểm tra trạng thái database hiện tại

```bash
npm run db:status
```

Output mẫu:
```
========================================
   Database Status Checker
========================================

📊 Chế độ: 💾 SQLite Local

📂 SQLite:
   ✅ File tồn tại: d:\KHCN-DMST\data\sci-ace.db
   📦 Kích thước: 2.45 MB
   📋 Số bảng: 28
   📊 Tổng số dòng: 1,234

   📈 Top 5 bảng lớn nhất:
      1. submissions: 156 dòng
      2. users: 89 dòng
      ...
```

### 4.2 Chạy Migration

```bash
npm run migrate:turso
```

Quá trình migration sẽ:
1. Đọc toàn bộ dữ liệu từ SQLite
2. Tạo các bảng trên Turso
3. Insert dữ liệu từng bảng
4. Báo cáo tổng kết

**Lưu ý:** Migration có thể mất vài phút tùy dung lượng database.

### 4.3 Xác minh Migration

```bash
npm run db:status
```

Kiểm tra phần "Turso" trong output để xác nhận dữ liệu đã được migrate.

---

## 5. Deploy lên Cloudflare

### 5.1 Cloudflare Workers (Server-side)

#### Cài đặt Wrangler
```bash
npm install -g wrangler
```

#### Cấu hình `wrangler.toml`
```toml
name = "sci-ace"
main = "server.js"
compatibility_date = "2024-01-01"

[env.production]
name = "sci-ace"
routes = [{ pattern = "your-domain.com", zone_name = "your-domain.com" }]

# Turso binding
[[env.production.bindings]]
name = "TURSO_DATABASE"
type = "turso"
```

#### Deploy
```bash
wrangler deploy --env production
```

### 5.2 Cloudflare Pages (Static + Functions)

1. Push code lên GitHub
2. Kết nối repo với Cloudflare Pages
3. Thêm Environment Variables trong Pages Settings:
   - `DATABASE_URL`
   - `DATABASE_AUTH_TOKEN`
4. Deploy

---

## 6. Xử Lý Sự Cố

### 6.1 Lỗi "Database is locked"

**Nguyên nhân:** Nhiều connection đồng thời đến SQLite.

**Giải pháp:** Chuyển sang Turso (đã làm).

### 6.2 Lỗi "UNIQUE constraint failed"

**Nguyên nhân:** Dữ liệu trùng lặp khi migrate.

**Giải pháp:** Script migration đã xử lý tự động, bỏ qua các dòng trùng.

### 6.3 Lỗi kết nối Turso

1. Kiểm tra `DATABASE_URL` đúng format
2. Kiểm tra `DATABASE_AUTH_TOKEN` còn hiệu lực
3. Thử tạo token mới:
   ```bash
   turso db tokens invalidate sci-ace
   turso db tokens create sci-ace
   ```

### 6.4 Chạy local với SQLite sau khi đã cấu hình Turso

Sửa `.env`:
```env
# Comment dòng này để dùng SQLite local
# DATABASE_URL=libsql://sci-ace-xxxx.turso.io
# DATABASE_AUTH_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Hoặc xóa hoàn toàn các biến trên
```

---

## So Sánh SQLite vs Turso

| Tiêu chí | SQLite | Turso |
|----------|--------|-------|
| **Hosting** | Local file | Cloud (Edge) |
| **Concurrency** | Giới hạn | Không giới hạn |
| **Replication** | Không | Có (tự động) |
| **Cloudflare** | Không | Có |
| **Free tier** | Miễn phí | 9GB, 500 req/s |
| **Setup** | Đơn giản | Trung bình |
| **Latency** | Thấp (local) | Trung bình |

---

## Backup & Restore

### Backup từ Turso
```bash
turso db shell sci-ace
# Trong shell:
.output backup.sql
.dump
.exit
```

### Restore vào Turso
```bash
turso db shell sci-ace < backup.sql
```

---

## Liên Hệ Hỗ Trợ

- Tài liệu Turso: https://docs.turso.tech
- Discord: https://discord.gg/turso
- GitHub Issues: https://github.com/tursodatabase/libsql

---

**Ngày cập nhật:** $(date +%Y-%m-%d)
