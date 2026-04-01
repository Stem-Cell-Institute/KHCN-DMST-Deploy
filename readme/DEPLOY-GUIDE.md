# Hướng Dẫn Deploy - Hệ Thống SCI-ACE (KHCN & ĐMST)

> **Database đang dùng: SQLite** (file trên disk, đơn giản, hiệu quả)

---

## Mục lục

1. [Tổng quan SQLite](#1-tổng-quan-sqlite)
2. [Yêu cầu hệ thống](#2-yêu-cầu-hệ-thống)
3. [Các bước cài đặt](#3-các-bước-cài-đặt)
4. [Cấu hình .env](#4-cấu-hình-env)
5. [Cấu hình Production](#5-cấu-hình-production)
6. [Reverse Proxy + HTTPS](#6-reverse-proxy--https)
7. [Quản lý Process (PM2)](#7-quản-lý-process-pm2)
8. [Backup Dữ liệu](#8-backup-dữ-liệu)
9. [Khắc phục sự cố](#9-khắc-phục-sự-cố)

---

## 1. Tổng quan SQLite

### SQLite hoạt động như thế nào?

| Thao tác | SQLite xử lý |
|----------|-------------|
| **Đọc dữ liệu** (xem danh sách, tìm kiếm) | ✅ Nhiều người đọc **đồng thời**, không chờ nhau |
| **Ghi dữ liệu** (đăng ký lịch, nộp đề tài) | ✅ Tự động xếp hàng, chờ vài milliseconds |
| **10 người đăng ký 10 slot khác nhau** | ✅ Tất cả thành công |
| **10 người đăng ký cùng 1 slot** | ✅ Người đầu được, người sau nhận thông báo "đã bị đặt" |
| **20 người nộp 20 đề tài cùng lúc** | ✅ Tất cả thành công |

### SQLite phù hợp với:

- ✅ Máy chủ đơn (1 server)
- ✅ 1-50 người dùng đồng thời
- ✅ Hệ thống đăng ký lịch, quản lý đề tài
- ✅ IT không cần quản lý database server riêng

### SQLite KHÔNG phù hợp với:

- ❌ Nhiều server chạy cùng lúc (cần replication)
- ❌ 100+ người ghi dữ liệu đồng thời liên tục

---

## 2. Yêu cầu hệ thống

### Yêu cầu tối thiểu

| Thành phần | Yêu cầu |
|------------|---------|
| **OS** | Ubuntu 20.04+, Debian 11+, macOS, Windows Server 2019+ |
| **Node.js** | v18 LTS hoặc v20 LTS |
| **RAM** | 1GB (tối thiểu), 2GB+ (khuyến nghị) |
| **Disk** | 20GB+ (tùy dung lượng file upload) |
| **Backup** | 10GB+ (cho các bản backup) |

### Cài đặt Node.js (Ubuntu/Debian)

```bash
# Cài Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Kiểm tra
node --version   # → v20.x.x
npm --version
```

---

## 3. Các bước cài đặt

### Bước 3.1: Chuẩn bị thư mục

```bash
# Tạo thư mục cho ứng dụng
sudo mkdir -p /opt/sci-ace
sudo chown $USER:$USER /opt/sci-ace
cd /opt/sci-ace

# Clone hoặc copy source code vào đây
```

### Bước 3.2: Cài đặt dependencies

```bash
npm install
```

### Bước 3.3: Cấu hình môi trường

```bash
# Copy file mẫu
cp .env.example .env

# Chỉnh sửa .env (xem mục 4)
nano .env
```

### Bước 3.4: Tạo thư mục cần thiết

```bash
# Các thư mục sẽ được tự động tạo khi chạy app:
# - data/          (chứa database SQLite)
# - uploads/       (chứa file upload)
# - uploads-cap-vien/  (chứa file đề tài cấp Viện)
```

### Bước 3.5: Test nhanh

```bash
# Chạy thử server
npm start

# Mở trình duyệt: http://localhost:3000
# Nhấn Ctrl+C để dừng
```

### Bước 3.6: Khởi động với PM2 (chạy 24/7)

```bash
# Cài PM2 (nếu chưa có)
npm install -g pm2

# Khởi động app
pm2 start npm --name "sci-ace" -- start

# Lưu danh sách process
pm2 save

# Cấu hình khởi động cùng hệ thống
pm2 startup
```

---

## 4. Cấu hình .env

### File `.env` mẫu cho Production

```bash
# =============================================
# SERVER
# =============================================
PORT=3000
BASE_URL=https://your-domain.com

# =============================================
# DATABASE - SQLite (đã cấu hình sẵn)
# =============================================
# File database: ./data/sci-ace.db
# Không cần thay đổi gì thêm!

# =============================================
# JWT - BẮT BUỘC thay đổi!
# =============================================
JWT_SECRET=YOUR_VERY_LONG_RANDOM_SECRET_HERE

# Tạo secret ngẫu nhiên:
# node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# =============================================
# EMAIL (SMTP)
# =============================================
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=hethongquanlykhcn_dmst@sci.edu.vn

# =============================================
# BẢO MẬT
# =============================================
NODE_ENV=production
```

### Tạo JWT_SECRET mới

```bash
# Chạy lệnh này để tạo secret ngẫu nhiên
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Copy kết quả (64 ký tự hex) vào JWT_SECRET
```

---

## 5. Cấu hình Production

### Checklist bảo mật

- [ ] **JWT_SECRET** đã được thay đổi (không dùng mặc định)
- [ ] **HTTPS** đã được bật (qua Cloudflare hoặc Let's Encrypt)
- [ ] File **`.env`** đã được đặt quyền `chmod 700`
- [ ] **Firewall** chỉ mở port 80, 443
- [ ] **PM2** đã được cấu hình startup

### Đặt quyền file .env (bắt buộc)

```bash
chmod 700 /opt/sci-ace/.env
```

---

## 6. Reverse Proxy + HTTPS

### Option A: Cloudflare (Khuyến nghị)

1. Đăng ký domain tại Cloudflare
2. Thêm site và trỏ DNS về IP server
3. Bật **Proxy mode** (icon tròn màu cam)
4. SSL/TLS mode: **Full**

### Option B: Nginx + Let's Encrypt

#### Cài đặt Nginx

```bash
sudo apt update
sudo apt install -y nginx
sudo systemctl enable nginx
```

#### Tạo cấu hình Nginx

```bash
sudo nano /etc/nginx/sites-available/sci-ace
```

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
```

#### Cài Let's Encrypt (SSL miễn phí)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

#### Kích hoạt cấu hình

```bash
sudo ln -s /etc/nginx/sites-available/sci-ace /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 7. Quản lý Process (PM2)

### Các lệnh PM2 thường dùng

```bash
pm2 status              # Xem trạng thái tất cả process
pm2 logs sci-ace        # Xem logs (Ctrl+C để thoát)
pm2 restart sci-ace     # Khởi động lại app
pm2 stop sci-ace        # Dừng app
pm2 monit               # Monitoring real-time
pm2 delete sci-ace      # Xóa process
pm2 save                # Lưu danh sách process hiện tại
```

### Kiểm tra app có chạy không

```bash
pm2 status
# Output mẫu:
# ┌─────┬───────────┬─────────────┬─────────┬─────────┬──────┬───────────┐
# │ id  │ name      │ mode        │ status  │ cpu     │ mem  │ uptime    │
# ├─────┼───────────┼─────────────┼─────────┼─────────┼──────┼───────────┤
# │ 0   │ sci-ace   │ fork        │ online  │ 0.2%    │ 85MB │ 5 days    │
# └─────┴───────────┴─────────────┴─────────┴─────────┴──────┴───────────┘

# Status "online" = đang chạy tốt
# Status "errored" = có lỗi, cần xem logs
```

---

## 8. Backup Dữ liệu

### Tạo script backup

```bash
nano /opt/sci-ace/backup.sh
```

```bash
#!/bin/bash
# ========================================
# Backup Script cho SCI-ACE
# ========================================

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/opt/backups/sci-ace
APP_DIR=/opt/sci-ace

# Tạo thư mục backup nếu chưa có
mkdir -p $BACKUP_DIR

# ========================================
# 1. Backup Database SQLite
# ========================================
# Đóng mở file để đảm bảo dữ liệu được ghi hoàn toàn
sqlite3 $APP_DIR/data/sci-ace.db "VACUUM;"
cp $APP_DIR/data/sci-ace.db $BACKUP_DIR/sci-ace-$DATE.db
echo "[$DATE] Database backup: sci-ace-$DATE.db"

# ========================================
# 2. Backup Uploads
# ========================================
tar -czf $BACKUP_DIR/uploads-$DATE.tar.gz -C $APP_DIR uploads/
tar -czf $BACKUP_DIR/uploads-cap-vien-$DATE.tar.gz -C $APP_DIR uploads-cap-vien/
echo "[$DATE] Uploads backup completed"

# ========================================
# 3. Xóa backup cũ hơn 30 ngày
# ========================================
find $BACKUP_DIR -name "*.db" -mtime +30 -delete
find $BACKUP_DIR -name "*.tar.gz" -mtime +30 -delete
echo "[$DATE] Old backups cleaned up"

# ========================================
# 4. Tổng kết
# ========================================
echo "[$DATE] Backup hoàn tất!"
du -sh $BACKUP_DIR/*
```

```bash
# Phân quyền execute
chmod +x /opt/sci-ace/backup.sh
```

### Cấu hình Cronjob (chạy tự động)

```bash
# Mở crontab
crontab -e

# Thêm dòng này (chạy mỗi ngày lúc 2:00 sáng)
0 2 * * * /opt/sci-ace/backup.sh >> /opt/logs/backup.log 2>&1

# Tạo thư mục log
sudo mkdir -p /opt/logs
```

### Restore từ Backup

```bash
# 1. Dừng app
pm2 stop sci-ace

# 2. Copy backup vào
cp /opt/backups/sci-ace/sci-ace-20260327_020000.db /opt/sci-ace/data/sci-ace.db

# 3. Giải nén uploads (nếu cần)
tar -xzf /opt/backups/sci-ace/uploads-20260327_020000.tar.gz -C /opt/sci-ace/

# 4. Khởi động lại app
pm2 restart sci-ace
```

### Kiểm tra backup có hoạt động không

```bash
# Chạy thủ công để test
/opt/sci-ace/backup.sh

# Kiểm tra file backup có tạo không
ls -la /opt/backups/sci-ace/
```

---

## 9. Khắc phục sự cố

### App không khởi động

```bash
# Xem log lỗi chi tiết
pm2 logs sci-ace --lines 50

# Kiểm tra .env
cat /opt/sci-ace/.env

# Kiểm tra quyền thư mục
ls -la /opt/sci-ace/data/
```

### Lỗi kết nối database

```bash
# Kiểm tra file tồn tại
ls -la /opt/sci-ace/data/sci-ace.db

# Test SQLite trực tiếp
sqlite3 /opt/sci-ace/data/sci-ace.db ".tables"
# Nếu thấy danh sách bảng = database hoạt động tốt
```

### Lỗi Permission (Linux)

```bash
sudo chown -R $USER:$USER /opt/sci-ace
sudo chmod -R 755 /opt/sci-ace
sudo chmod 700 /opt/sci-ace/.env
```

### Lỗi CORS

Kiểm tra biến `BASE_URL` trong `.env` khớp với domain thực tế:
```bash
grep BASE_URL /opt/sci-ace/.env
# Phải là: BASE_URL=https://your-domain.com
```

### Upgrade app

```bash
# Pull code mới
git pull

# Cài dependency mới (nếu có)
npm install

# Restart
pm2 restart sci-ace

# Kiểm tra logs
pm2 logs sci-ace --lines 20
```

---

## Liên hệ hỗ trợ

- **Dev team:** Liên hệ qua email/chat nội bộ
- **Logs:** `pm2 logs sci-ace`
- **Database file:** `/opt/sci-ace/data/sci-ace.db`
- **Backup folder:** `/opt/backups/sci-ace/`
