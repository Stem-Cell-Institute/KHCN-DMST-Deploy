# Kế hoạch deploy: Fix nút "Admin Panel" trỏ sai khi online

> **Gửi: Bộ phận IT / Vận hành `khcn-dmst.sci.edu.vn`**
> **Mức độ**: Sửa lỗi UX, không đổi schema DB, không đổi API, an toàn.
> **Ước lượng**: 5–10 phút downtime (chỉ khi restart Node). Không cần sửa nginx nếu mục 4 ở mục _Kiểm tra nginx_ đã đúng.

---

## 1. Tóm tắt lỗi

- Trang **Quy trình văn bản nội bộ** (có thể vào qua `/admin/documents` hoặc `/documents` tùy môi trường) có nút **Admin Panel** (bên React SPA, component `WorkflowTopNav`).
- Ở máy dev (local) bấm nút → mở đúng `/admin/module-settings`.
- Trên production (`khcn-dmst.sci.edu.vn`) nút này "lúc đúng lúc sai": nhiều lần trỏ sang URL không mong muốn (ví dụ `/module-settings` thiếu prefix `/admin`, hoặc URL lạ tuỳ session).

### Nguyên nhân

Nút cũ dùng `<Link to="/module-settings">` của **React Router**. SPA build với `vite base = "/admin/"` nên mặc định Router có `basename = /admin`. Khi deploy qua nginx, có môi trường để nguyên URL `/documents` (không có `/admin`) → basename bị lệch với pathname thực tế và `<Link>` sinh URL không ổn định.

### Cách sửa

Triển khai 2 lớp bảo vệ:
1) Chuyển các nút chuyển-vùng (Admin Panel ⇄ Danh sách hồ sơ React) sang **`<a href>` URL tuyệt đối** (full reload, không phụ thuộc state router).  
2) Thêm **runtime basename auto-detect** cho Router: nếu URL hiện tại bắt đầu bằng `/admin` thì dùng `basename="/admin"`, còn nếu đang chạy trực tiếp ở root (`/documents`) thì `basename=undefined`.  

Kết quả: cùng một bundle hoạt động ổn định cho cả 2 kiểu mapping hạ tầng, không bắt buộc IT sửa nginx ngay.

---

## 2. Các file đã đổi trong repo

| Trạng thái | File | Ghi chú |
|---|---|---|
| Sửa | `frontend/document-workflow-ui/src/components/WorkflowTopNav.tsx` | Nút "Admin Panel" dùng `<a href>` |
| Sửa | `frontend/document-workflow-ui/src/features/document-workflow/admin/pages/AdminLayout.tsx` | Nút "Danh sách hồ sơ (React)" dùng `<a href>` |
| Thêm | `frontend/document-workflow-ui/src/lib/url.ts` | Helper `buildAppUrl(path)` + `getRuntimeRouterBasename()` |
| Sửa | `frontend/document-workflow-ui/src/main.tsx` | Router dùng runtime basename auto-detect |
| Sửa | `frontend/document-workflow-ui/src/features/document-workflow/admin/components/AdminGuard.tsx` | Không redirect khi lỗi kỹ thuật (hiển thị cảnh báo tại chỗ), chỉ coi là "không có quyền" khi API trả 401/403 |
| Sửa | `server.js` | Tự rebuild `dist/` khi phát hiện source React mới hơn bundle (tránh lỗi "pull code mà quên xoá dist") |

**Không sửa**: DB migrations, routes backend logic, nginx config (trừ khi mục 4 ở phần kiểm tra phát hiện lệch). `server.js` chỉ thêm block auto-rebuild khi stale, không đổi hành vi route/API hiện tại.

Commit/PR tương ứng sẽ xuất hiện trên nhánh `main` trước khi IT pull (người bàn giao sẽ push sau khi cả bạn review xong).

---

## 3. Các bước deploy (copy–paste, không cần liên hệ lại)

> Giả định: repo trên server đặt tại `/opt/khcn-dmst` (hoặc thư mục tương đương). Service Node chạy qua `pm2` hoặc `systemd` (điều chỉnh lệnh restart theo thực tế của server).

```bash
# 0) Vào thư mục dự án
cd /opt/khcn-dmst                # ← sửa đúng path server nếu khác

# 1) Pull code mới
git fetch --all
git pull --ff-only origin main   # ← hoặc nhánh đang deploy

# 2) Restart Node server (chọn 1 trong các dòng dưới theo setup thực tế)
#    Server sẽ tự phát hiện source mới hơn dist và chạy lại npm install + npm run build
#    trước khi listen. Lần khởi động đầu có thể mất ~30–60s vì build tsx.
pm2 restart sci-ace              # nếu dùng pm2 (tên process thực tế có thể khác, kiểm tra: pm2 ls)
# systemctl restart sci-ace      # nếu dùng systemd unit
# hoặc dừng-chạy lại thủ công: pkill -f "node server.js" && nohup node server.js > server.log 2>&1 &

# 3) (Chỉ khi cần) Build tay:
# rm -rf frontend/document-workflow-ui/dist
# cd frontend/document-workflow-ui && npm ci && npm run build && cd ../..
# pm2 restart sci-ace
```

**Biến môi trường**: không cần thay đổi. `ADMIN_UI_AUTO_BUILD` giữ mặc định (bật). Từ commit này, server sẽ so mtime `src/` với `dist/index.html`; nếu source mới hơn thì tự rebuild (log: `[ADMIN UI] Stale build detected: ...`). Nếu muốn tắt auto-rebuild (vd build CI riêng), đặt `ADMIN_UI_AUTO_BUILD=0`.

**Lưu ý về Cloudflare / CDN (nếu có đặt trước nginx)**: cần **Purge Cache** cho các path:
- `/admin`
- `/admin/` (và tất cả `/admin/*`)
- `/admin/assets/*`
- `/admin-ui-status`

Nếu chưa bật Cloudflare/CDN thì bỏ qua.

---

## 4. Kiểm tra nginx (one-time, chỉ làm nếu phần 5 Smoke Test thất bại)

Hầu hết trường hợp nginx đã cấu hình đúng — bỏ qua mục này. Chỉ vào đây nếu Smoke Test ở mục 5 vẫn lỗi.

### 4a. Phải có

`/admin` và `/admin/*` proxy thẳng về Node backend, **không rewrite URL**:

```nginx
# Ví dụ tối giản — thêm vào server { } đang phục vụ khcn-dmst.sci.edu.vn
location /admin {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
location /admin/ {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

### 4b. Phải KHÔNG có

**Bất kỳ rewrite/alias nào từ `/documents` → `/admin/documents`** (hoặc ngược lại). Điển hình các dòng cần **xoá** nếu gặp:

```nginx
# ❌ XOÁ nếu tồn tại — đây chính là gốc gây basename lệch pha
rewrite ^/documents(.*)$ /admin/documents$1 last;

# ❌ XOÁ nếu tồn tại
location /documents {
  proxy_pass http://127.0.0.1:3000/admin/documents;   # đổi URL → SAI
}
```

### 4c. Khuyến nghị (không bắt buộc)

Để user gõ sai URL vẫn tới được trang đúng, thêm redirect **302** (giữ URL browser rõ ràng, **không rewrite ngầm**):

```nginx
location = /documents        { return 302 /admin/documents; }
location = /module-settings  { return 302 /admin/module-settings; }
```

Sau khi sửa nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 4d. Giới hạn upload

Giữ nguyên snippet `deploy/nginx-upload-limit-snippet.conf` (`client_max_body_size 25m;`) trong `server { }` — không liên quan lỗi này, chỉ nhắc để không vô tình xoá khi sửa nginx.

---

## 5. Smoke Test (sau deploy)

Thực hiện lần lượt. Nếu bước nào fail → xem mục 6 (Rollback) hoặc quay lại mục 4 (Kiểm tra nginx).

### 5.1. Health check

```bash
curl -s https://khcn-dmst.sci.edu.vn/admin-ui-status | jq
```

Kết quả kỳ vọng:

```json
{
  "ok": true,
  "mode": "react-build",
  "reactBuildIndexExists": true,
  "adminPath": "/admin"
}
```

Nếu `mode` là `"legacy-fallback"` hoặc `"unavailable"` → build chưa vào, quay lại bước 2–3 phần deploy.

### 5.2. Kiểm tra bundle mới được serve

```bash
curl -s https://khcn-dmst.sci.edu.vn/admin/ | grep -Eo '/admin/assets/index-[A-Za-z0-9_-]+\.js'
```

Kết quả kỳ vọng: in ra **đúng 1 path** dạng `/admin/assets/index-<hash>.js`. Hash phải **khác với hash đang chạy trước khi deploy** (có thể so với screenshot/log cũ).

### 5.3. Kiểm tra hành vi nút "Admin Panel" trên browser

1. Mở (ở chế độ ẩn danh, tránh cache): `https://khcn-dmst.sci.edu.vn/admin/documents` **hoặc** `https://khcn-dmst.sci.edu.vn/documents` (tùy hạ tầng đang map path nào).
2. Đăng nhập tài khoản có quyền `module_manager` hoặc `master_admin` hoặc `admin`.
3. Ở góc phải thanh trên, bấm nút **Admin Panel**.
4. Kỳ vọng: URL đổi sang trang module settings tương ứng với prefix hiện tại (thường là `/admin/module-settings`; một số môi trường có thể là `/module-settings`). Bấm lặp lại nhiều lần (F5, navigate qua lại): URL **ổn định theo cùng một kiểu prefix**, không nhảy lung tung.
5. Ở trang Admin Panel, bấm nút **Danh sách hồ sơ (React)** trong sidebar → URL quay về trang documents tương ứng cùng prefix (thường `/admin/documents` hoặc `/documents`).

### 5.4. Regression check

- Mở `https://khcn-dmst.sci.edu.vn/quy-trinh-van-ban-noi-bo.html` (giao diện legacy) → vẫn load, nút "Admin Panel" (legacy, `<a href="/admin/module-settings">`) vẫn đúng như trước.
- Mở `https://khcn-dmst.sci.edu.vn/index.html` → trang chủ vẫn bình thường.

---

## 6. Rollback nhanh (nếu có sự cố sau deploy)

Fix này chỉ động vào frontend bundle. Rollback bằng cách revert code + rebuild:

```bash
cd /opt/khcn-dmst
git log --oneline -5               # xác định commit fix
git revert --no-edit <commit-hash-cua-fix>
rm -rf frontend/document-workflow-ui/dist
cd frontend/document-workflow-ui && npm ci && npm run build && cd ../..
pm2 restart sci-ace                # hoặc lệnh restart đang dùng
```

Không cần động DB, không cần xoá user state/cookie.

---

## 7. Điểm liên hệ

- Nội dung fix & context kỹ thuật: (người gửi ticket này).
- Vấn đề hạ tầng/nginx/DNS/SSL: giữ nguyên owner hiện tại của server.

Nếu Smoke Test 5.3 vẫn fail **sau khi** đã thực hiện đầy đủ mục 3 + kiểm tra mục 4, vui lòng thu thập:

1. Output `curl -s https://khcn-dmst.sci.edu.vn/admin-ui-status`.
2. Output `curl -sI https://khcn-dmst.sci.edu.vn/admin/documents` và `curl -sI https://khcn-dmst.sci.edu.vn/documents`.
3. File nginx config đang active cho `khcn-dmst.sci.edu.vn` (đã che bí mật nếu có).

Gửi lại theo kênh nội bộ — không cần trao đổi qua lại trước khi có 3 artifact trên.
