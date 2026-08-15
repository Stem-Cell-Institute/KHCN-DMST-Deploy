# CLAUDE.md

Ngữ cảnh dài hạn cho mọi phiên làm việc. Đọc file này trước khi sửa code.

## Hệ thống

**STIMS / SCI-ACE** — Hệ thống Quản lý Khoa học Công nghệ & Đổi mới sáng tạo, Viện Tế bào gốc
(Trường ĐH Khoa học Tự nhiên, ĐHQG TP.HCM).

**Đang chạy thật tại `https://eoffice.sci.edu.vn`** — người dùng thật, dữ liệu thật. Mọi thay đổi
phải giả định là sẽ lên production.

Nghiệp vụ: đề tài cấp Viện, nhiệm vụ KHCN, hợp tác quốc tế (đoàn ra/vào, MOU, YTNN), công bố khoa
học + ORCID, đặt lịch thiết bị CRD, văn bản hành chính nội bộ, hội đồng đạo đức.

## Lệnh

```bash
npm start          # node server.js
npm test           # node --test tests/**/*.test.js — smoke test, chạy TRƯỚC và SAU mỗi thay đổi
npm run build      # build admin UI (Vite) + bundle CRD (esbuild)
node scripts/route-inventory.js    # liệt kê toàn bộ route đã đăng ký (dùng để diff khi refactor)
```

## Kiến trúc

| Thư mục | Vai trò |
|---|---|
| `server.js` | **19.836 dòng, 360 endpoint** — đang được tách dần |
| `routes/` | tầng HTTP (đọc `req`, ghi `res`), theo mẫu factory `createXxxRouter({ db, ... })` |
| `services/` | nghiệp vụ thuần, không biết `req`/`res` |
| `middleware/` | auth, phân quyền, upload |
| `lib/` | hạ tầng: `database.js`, `appPaths.js`, `config.js`, `filenames.js`, `upload.js` |
| `modules/document-workflow/` | module duy nhất đã có kiến trúc lớp đầy đủ — **dùng làm mẫu** |
| `tests/` | smoke test + helper khởi động server trong hộp cát |
| `readme/` | tài liệu tiếng Việt |

Frontend là hỗn hợp: 49 trang `.html` tĩnh ở thư mục gốc, EJS trong `views/`, và hai app build
(`frontend/document-workflow-ui` dùng Vite, `crd-lab-booking` dùng esbuild).

## Đang refactor — đọc trước khi sửa

`server.js` đang được tách thành router theo 8 đợt.

- Kế hoạch & quy ước đặt tên: [readme/KE-HOACH-REFACTOR.md](readme/KE-HOACH-REFACTOR.md)
- Trạng thái hiện tại & bàn giao phiên trước: [readme/REFACTOR-PROGRESS.md](readme/REFACTOR-PROGRESS.md)

Quy tắc rút gọn: một đợt = một branch = một PR = một phiên. Trần ~400 dòng/đợt. Refactor **không
đổi hành vi** — cắt–dán thuần, không sửa logic trong cùng commit. Việc phát sinh ngoài phạm vi thì
ghi vào mục "Nợ kỹ thuật" của PROGRESS, không làm luôn.

Tên branch và thư mục dùng **ASCII, không dấu tiếng Việt** (checkout trên server Linux sẽ hỏng).

## Cạm bẫy đã biết

**Thứ tự đăng ký route có ý nghĩa.** Route tĩnh phải khai báo *trước* route `:id`, nếu không sẽ bị
nuốt — xem ghi chú sẵn có tại `server.js:19604`. Khi di chuyển handler, giữ nguyên vị trí `app.use`.

**`express.static(__dirname)` phục vụ toàn bộ thư mục gốc** (`server.js:19286`). Vì vậy mới có một
middleware chặn tải mã nguồn/cấu hình bằng **danh sách chặn** ở `server.js:19034`. Hệ quả: file mới
thêm vào gốc mà chưa nằm trong danh sách chặn thì tải về được. Đây là blocklist chứ không phải
allowlist — đã ghi vào Nợ kỹ thuật.

**Hai cơ sở dữ liệu tách biệt:** `data/sci-ace.db` (chính, ~19 MB) và `data/de-tai-cap-vien.db`
(đề tài cấp Viện, upload riêng). Đừng giả định chỉ có một DB.

**Đường dẫn dữ liệu tách khỏi code.** `lib/appPaths.js` đọc `APP_DATA_DIR`, `SQLITE_PATH`,
`UPLOADS_DIR`… Không hard-code `path.join(__dirname, 'data')`.

**Hai driver DB.** `lib/database.js` trừu tượng hóa better-sqlite3 (local) và libsql/Turso (deploy).
Dùng qua lớp này, đừng gọi thẳng driver.

**Tên file tiếng Việt dễ hỏng.** `busboy` đọc multipart theo latin1 → mojibake. Đã có
`lib/filenames.js` (`decodeUploadedFilename`) và `scripts/fix-mojibake-filenames.js` để sửa. Khi
đụng tới upload, đi qua helper này.

**Test chạy trên máy có dữ liệu thật.** `tests/helpers/testServer.js` copy DB sang thư mục tạm, trỏ
`APP_DATA_DIR` vào hộp cát và để `SMTP_*` rỗng (không gửi email). Cần `JWT_SECRET` trong `.env` và
`data/sci-ace.db` tồn tại. Đừng viết test ghi thẳng vào `data/`.

## Quy ước

- File JS backend: `camelCase.js`. URL / HTML / CSS: `kebab-case`, không dấu.
- Bảng & cột DB: `snake_case`.
- **Không đổi đường dẫn API và đường dẫn `.html`** — đó là hợp đồng với 49 trang frontend và người
  dùng đang chạy thật.
- Toàn bộ giao diện, comment và tài liệu viết bằng tiếng Việt.
