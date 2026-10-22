# Tiến độ refactor `server.js`

Kế hoạch & quy ước: [KE-HOACH-REFACTOR.md](KE-HOACH-REFACTOR.md)

**Mọi phiên làm việc cập nhật file này ở cuối phiên.** Không có bàn giao = phiên sau phải đọc lại
19.836 dòng.

---

## Bảng đợt

| Đợt | Nhóm | Endpoint | Trạng thái | Branch |
|---|---|---|---|---|
| 0 | Hạ tầng quản lý + dọn tên | 0 | ✅ Đã merge (`96ec09b`, PR #3) | ~~`chore/dot-0-ha-tang-refactor`~~ đã xóa |
| 1 | `missions` — **chia 4 PR + 1 PR gom thư mục** (khối 1.431 dòng, gấp 3,5 lần trần) | 40 | ✅ **Xong — `server.js` hết `/api/missions`** | xem bảng dưới |
| └ 1.1 | `stats`, danh sách, tạo mới | 3 | ✅ Đã merge (`931e1b0`, PR #6) · −320 dòng | ~~`refactor/routes-missions-1`~~ |
| └ 1.2 | `files`, `cn-info`, bước 2–3, `reset-ve-buoc3` | 13 | ✅ Đã merge (`1fe9748`, PR #8) · −345 dòng | ~~`refactor/routes-missions-2`~~ |
| └ 1.3 | bước 4a / 4b / 5 / 6 | 13 | ✅ Đã merge (`500975a`, PR #9) · −337 dòng | ~~`refactor/routes-missions-3`~~ |
| └ 1.4 | `cho-ct-hd` + `by-code`, `:id`, hồ sơ ngoài, sản phẩm — **2 router** | 11 | ✅ Đã merge (`6ae4cc2`, PR #10) · −283 dòng | ~~`refactor/routes-missions-4`~~ |
| └ 1.5 | Gom 7 file `routes/missions*` → `routes/missions/` — **chỉ di chuyển file** | 0 | 🔵 Chờ review (PR 1.5) | `refactor/gom-routes-missions` |

**Đợt 1 đã khép.** `server.js` không còn endpoint `/api/missions` nào; 40 endpoint nằm trong 7 file
dưới `routes/missions/` (§2.3 kế hoạch — domain vượt 3 file thì tách thư mục con).

**Thứ tự mount bắt buộc trong `server.js`** (đừng đổi, đừng gộp):

```
routes/missions/core.js          /missions/stats
routes/missions/hoSo.js
routes/missions/pheDuyet.js
routes/missions/choXetDuyet.js   /missions/cho-ct-hd-*
routes/missions/export.js        /missions/export*, /missions/report-excel
routes/missions/chiTiet.js       /missions/:id        ← PHẢI SAU CÙNG trong nhóm này
routes/missions/templates.js     /missions-templates  (segment khác, không va chạm)
```

> **Không gom 7 router thành một `index.js`.** §2.3 của kế hoạch có gợi ý mỗi domain xuất một
> router duy nhất, nhưng ở đây **không áp dụng được**: `chiTiet.js` chứa `/missions/:id`, mà handler
> đó trả 400 và không gọi `next()`. Gộp lại rồi mount một lần sẽ đặt `:id` cùng vị trí với
> `export.js` và `core.js` — `/api/missions/export` và `/stats` sẽ bị nuốt. Bảy mount riêng ở bảy vị
> trí là **điều kiện đúng đắn**, không phải nợ kỹ thuật.
| 2 | `crd` | 36 | ⬜ Chưa bắt đầu | — |
| 3 | `submissions` + `publications` | 36 | ⬜ Chưa bắt đầu | — |
| 4 | `cap-vien` | 47 | ⬜ Chưa bắt đầu | — |
| 5 | `cooperation` + `htqt` + `events` | 84 | ⬜ Chưa bắt đầu | — |
| 6 | `admin` | 79 | ⬜ Chưa bắt đầu | — |
| 7 | `core` + rút `server.js` < 300 dòng | ~15 | ⬜ Chưa bắt đầu | — |

Ký hiệu: ⬜ chưa bắt đầu · 🟡 đang làm · 🔵 chờ review/merge · ✅ đã merge + deploy ổn định

**Số dòng `server.js`:** 19.836 (mốc đầu, `3718304`) → **18.551** hiện tại → *mục tiêu < 300*

Đã cắt **1.285 dòng** (6,6% chặng đường). Trần hiện tại nằm ở `.github/server-js-max-lines`, CI đỏ
nếu file dài ra. Mỗi đợt xong phải hạ con số đó xuống bằng số dòng mới.

---

## ✅ Mốc gốc đã có

Môi trường đã thông (Node 20.20.0, `npm ci` sạch):

| Kiểm chứng | Kết quả |
|---|---|
| `npm test` | **26/26 xanh** |
| `node scripts/route-inventory.js` | **619 route**, giải mã đường dẫn sạch 100% (không dòng `<regexp:>` nào) |
| Server khởi động | OK, trang chủ render, không lỗi console |

Sinh lại mốc gốc bất cứ lúc nào:

```bash
node scripts/route-inventory.js > routes-baseline.txt
```

> **619 chứ không phải 360.** Con số 360 là đếm `app.get/post/...` bằng grep trong `server.js`.
> 619 là số route **thực sự đăng ký**, gồm cả router đã tách sang `routes/`, `modules/`, và mỗi
> HTTP method tính một dòng. Khi refactor phải đối chiếu theo **619**.

---

## ⚠️ Preview local dùng DỮ LIỆU THẬT

`npm start` / preview đọc thẳng `data/sci-ace.db` và **SMTP trong `.env` đang bật** — thao tác trên
preview sẽ ghi vào dữ liệu thật và **gửi email thật cho người dùng thật**.

Chỉ `npm test` là an toàn (`tests/helpers/testServer.js` copy DB sang thư mục tạm, để `SMTP_*` rỗng).

Muốn bấm thử thoải mái thì chạy server với biến môi trường hộp cát giống test: `SQLITE_PATH` trỏ
vào bản sao DB, `APP_DATA_DIR` trỏ thư mục tạm, `SMTP_HOST=""`.

---

## Sự cố phiên bản Node — đã xử lý, ghi lại để không lặp

Máy dev ban đầu không có Node. Cài Node 24 thì server chết ngay lúc khởi động:
`better_sqlite3.node` trong `node_modules/` được build bằng Node 22 (ABI 127), Node 24 cần ABI 137
→ `ERR_DLOPEN_FAILED`. Máy không có Visual Studio Build Tools nên `npm rebuild` không cứu được, và
`better-sqlite3` 11.7.0 không có bản prebuilt cho Node 24. Trong khi đó production dùng **Node 20**.

Cách xử lý: cài Node 20 (khớp production), `npm ci` tải prebuilt — **không cần Python hay Build
Tools**. Bài học: khi native module báo `NODE_MODULE_VERSION`, đừng đi hướng cài trình biên dịch;
hãy đưa Node về đúng bản mà production dùng.

Đã chốt bằng `engines` (package.json) + `.nvmrc` + `.npmrc` (`engine-strict=true`) để lần sau cài
sai bản là npm chặn ngay thay vì đổ vỡ giữa chừng.

Kèm theo: script `npm test` cũ là `node --test "tests/**/*.test.js"` — glob `**` chỉ nở từ Node 22,
trên Node 20 báo *Could not find*. Đã đổi thành `node --test tests/`, chạy được trên cả hai.

---

## Nợ kỹ thuật

Việc phát hiện dọc đường nhưng **cố ý không làm** để giữ phạm vi từng đợt.

| # | Việc | Phát hiện ở | Mức |
|---|---|---|---|
| 1 | **Node 20 nhiều khả năng đã hết vòng đời hỗ trợ** (lịch chính thức: ~04/2026; hôm nay 15/08/2026). `Dockerfile` dùng `node:20-bookworm-slim`, `engines` chốt `>=20 <21` — nếu đúng thì cả prod lẫn dev đang chạy runtime không còn bản vá bảo mật. **Kiểm chứng tại `https://endoflife.date/nodejs`.** Nếu đúng: nâng lên **Node 22 LTS** thành PR riêng (đổi `Dockerfile` + `engines` → `npm ci` → `npm test` → deploy). Lần nâng này sẽ gọn vì `engines` đã chốt sẵn. Quyết định chốt Node 20 hôm 15/08 vẫn đúng — đưa dev khớp prod là việc phải làm trước, nhưng không nên dừng ở đó. | Đợt 0 | **Cao — bảo mật + có hạn chót** |
| 2 | **`npm test` chưa chạy được trong CI.** `tests/helpers/testServer.js` bắt buộc có `data/sci-ace.db`, mà `data/*.db` bị gitignore (`.gitignore:138`) nên runner không có DB. Cách sửa: tạo DB mẫu chỉ có lược đồ + vài bản ghi giả, commit vào `tests/fixtures/`, cho helper dùng nó khi thiếu DB thật. Cho tới lúc đó `npm test` vẫn phải chạy tay. | Đợt 0 | **Cao — CI chỉ chặn được lỗi cú pháp, chưa chặn được lỗi hành vi** |
| 3 | `npm audit` báo **8 lỗ hổng (6 cao, 2 vừa)**. Đáng chú ý: `multer@1.4.5-lts.2` đã bị khai tử, bản 2.x mới có vá — mà đây là thư viện xử lý **toàn bộ upload** của hệ thống đang chạy thật. | Đợt 0 | **Bảo mật — nên xử lý sớm, PR riêng** |
| 4 | Chặn tải mã nguồn qua `express.static` đang dùng **blocklist** (`server.js:19034`). File mới thêm ở thư mục gốc mà quên khai báo sẽ tải về được. Nên đổi sang allowlist. | Đợt 0 | Bảo mật — nên làm sớm, PR riêng |
| 5 | `readme/DEPLOY-GUIDE.md` vẫn ghi yêu cầu "Node.js v18 LTS hoặc v20 LTS" — mâu thuẫn với `engines >=20 <21` vừa chốt. Ai làm theo hướng dẫn mà cài Node 18 sẽ bị `npm ci` chặn. Cập nhật hướng dẫn cùng lúc với nợ #1. | Đợt 0 | Trung bình — gây hiểu nhầm khi deploy |
| 6 | ~40 file `.docx` trong `templates/cap-vien/` và `templates/hoi-dong-dao-duc/` vẫn còn dấu tiếng Việt trong tên (`SCI-FINAL-01__ĐƠN_ĐỀ_NGHỊ_...docx`). Đợt 0 mới chỉ đổi tên **thư mục**. Cùng rủi ro checkout trên Linux, nhưng tên này người dùng nhìn thấy khi tải biểu mẫu → **cần quyết định của người dùng**, không tự đổi. | Đợt 0 | Trung bình — cần quyết định |
| 7 | `routes/equipmentPart2.js` — tên vô nghĩa, dấu hiệu tách vội. Gộp vào `routes/equipment/`. | Đợt 0 | Thấp — làm cùng đợt `equipment` |
| 8 | `data/` còn file backup `.db` cũ trên đĩa (`sci-ace-backup-20260321`, `test-unified.db`…). Đã gỡ khỏi Git và ignore, nhưng vẫn chiếm chỗ. | Đợt 0 | Rất thấp |
| 11 | **Font trang chủ nạp từ Google Fonts.** `index.html` tải Be Vietnam Pro qua `fonts.googleapis.com`. Máy chủ đặt tại Việt Nam nên đây là phụ thuộc mạng ngoài có thể chậm hoặc bị chặn, và trang chủ là trang công khai ai cũng vào. Nên self-host: tải 4 file `.woff2` (400/500/600/700) vào `public/fonts/`, khai `@font-face` với `font-display: swap`, bỏ 3 thẻ `<link>` Google. | Giao diện | Thấp — nhưng ảnh hưởng tốc độ trang công khai |
| 12 | **`js/auth-status.js` dùng emoji thay icon** (🔐 👤 ⚙️). Craft floor của skill thiết kế cấm emoji đứng thay hệ icon — icon phải được vẽ, cùng nét, cùng cân nặng. File này **dùng chung trên nhiều trang** nên không sửa trong lần làm lại trang chủ; sửa sẽ đổi giao diện mọi trang cùng lúc, cần làm thành PR riêng có rà soát. | Giao diện | Thấp |
| 13 | **`public/css/ticker.css` vi phạm hai mục của checklist emil.** (a) 3 quy tắc `:hover` không bọc trong `@media (hover: hover)` — trên cảm ứng hiệu ứng dính lại sau khi chạm. (b) Link tin trong dải chạy chỉ cao **32px**, dưới sàn tap target 44px. File này **dùng chung với trang quản trị ticker** nên không sửa trong lần làm lại trang chủ — sửa sẽ đổi cả hai nơi, cần PR riêng có rà soát. | Giao diện | Thấp |
| **9** | **Hai endpoint ghi không kiểm phân quyền.** `POST /api/missions/:id/buoc4a/cn-upload-thuyet-minh-chinh-sua` và `POST /api/missions/:id/buoc5/upload-thuyet-minh` chỉ có `authMiddleware` — **không kiểm vai trò, không kiểm chủ nhiệm đề tài**. Bất kỳ tài khoản đã đăng nhập nào, kể cả **`crd_user`** (tài khoản ngoài chỉ để đặt lịch phòng thí nghiệm), đều gọi được cho **mission id bất kỳ**: đánh dấu `thuyet_minh_chinh_sua_ok = 1` và kích hoạt email gửi cả danh sách Hội đồng, hoặc chèn bản ghi vào `buoc5_thuyet_minh_ls`. Đã di chuyển **nguyên trạng** ở Đợt 1.3 (refactor không được đổi hành vi) và có test ghim hiện trạng trong `tests/smoke.test.js`.<br><br>**Vì sao chưa vá:** cần quyết định nghiệp vụ — ai được upload? Chỉ chủ nhiệm, hay chủ nhiệm + thư ký? Và `missions.principal` là **tên dạng chuỗi**, không phải khóa ngoại tới `users`, nên không so khớp quyền sở hữu bằng một middleware được. Khác hẳn lỗ hổng `cn-info` (PR #7) vốn chỉ là quên một dòng.<br><br>**Giảm nhẹ:** cả hai chỉ mở trong một cửa sổ trạng thái quy trình (`thong_qua_co_chinh_sua`, hoặc đề tài đang ở Bước 5) và cần `file_id` hợp lệ của file đã upload trước đó. | Đợt 1.3 | **Bảo mật — quyền ghi, cần quyết định chính sách** |
| ~~10~~ | ✅ **ĐÃ VÁ** — `GET /api/missions/by-code/:code` nay có `authMiddleware`. Trước đó nó trả về toàn bộ bản ghi đề tài (`budget`, `approved_budget`, `disbursed_budget`, `contract_number`, `funding_source`) cho bất kỳ ai biết mã, mà mã sinh theo mẫu `DT-<2 chữ>-<năm>-<4 số>` nên dò được. Kiểm chứng trên server thật: không token **404 → 401**. Có 2 test canh không cho lỗ hổng quay lại. | Đợt 1.4 | ✅ Đã xử lý |

---

## Xử lý branch tồn đọng — đã chốt

Rà 3 branch treo từ tháng 4. **Cả ba đều còn trên `origin`**, nên xóa local là lấy lại được bất cứ
lúc nào; SHA ghi kèm để khôi phục nhanh.

| Branch | SHA | Nội dung thật | Quyết định |
|---|---|---|---|
| `Xác-thực-email-người-dùng` | `cae70ed` | Chỉ là **mockup giao diện**: sửa 1 file `admin-quan-ly-tai-khoan.html` chạy trên mảng `accounts` giả cứng trong JS. Thêm cột "Xác thực email" và nút "Thử đăng nhập" ghi rõ là *giả lập*. Không API, không backend, không đụng DB. | **Bỏ** — merge vào cũng không thêm chức năng nào |
| `REFACTOR` | `4122b16` | Code **đã lỗi thời**: thêm kiến trúc DDD cho `document-workflow`, nhưng `main` đã có sẵn kiến trúc đó (trùng cả 5 file `infrastructure/repositories/*Repository.js`) và còn đi tiếp qua 4 đợt sửa tới 13/08. Merge ngược là kéo lùi. | **Bỏ code**, đã **nhặt lại CI guardrails** (xem dưới) |
| `Chỉnh-sửa-giao-diện-Trang-chủ` | `df10727` | `index.html` trên `main` đã đổi qua **9 commit trong 4 tháng** kể từ khi branch tách; branch lại cắt 319 dòng khỏi đúng file đó. Một commit ("Loại bỏ file database khỏi Git") thì `main` đã tự làm ở `3718304`. | **Bỏ** — ý tưởng tách CSS nội tuyến ra `public/css/` nên làm lại từ đầu, rẻ hơn gỡ xung đột |

Lệnh xóa (chạy khi thuận tiện):

```bash
git branch -D "REFACTOR" "Xác-thực-email-người-dùng" "Chỉnh-sửa-giao-diện-Trang-chủ"
```

### Đã nhặt lại từ `REFACTOR`

Repo trước đó **không có CI nào**. Đã dựng `.github/workflows/guardrails.yml` theo tinh thần file
`document-workflow-guardrails.yml` của branch đó, nhưng viết lại cho hợp phạm vi hiện tại:

- `node --check` **74 file backend** — bắt lỗi cú pháp do cắt–dán ngay ở PR
- `npm ci` trên Node 20 — cũng là phép thử cho `engines` + `engine-strict`
- **Trần dòng `server.js`** (`.github/server-js-max-lines`): PR làm file này dài ra là CI đỏ. Mỗi
  đợt xong thì hạ con số xuống bằng số dòng thực tế — biến tiến độ refactor thành thứ máy canh.

Không lấy các cổng chặn về `@/shared/*`, `@/features/*` vì cấu trúc frontend đó chỉ tồn tại trong
branch `REFACTOR`, `main` không có.

19 file tài liệu `readme/refactor/` của branch đó **không lấy**: phạm vi chỉ cho `document-workflow`
(module `main` đã refactor xong), và viết không dấu tiếng Việt, lệch quy ước repo. Vẫn còn trên
`origin/REFACTOR` nếu sau này cần mẫu ADR / rollback runbook.

---

## Nhật ký bàn giao

> Mẫu — copy khối này lên đầu mục, mới nhất ở trên:
>
> ```markdown
> ### YYYY-MM-DD · <branch> · Đợt N
> - Đã xong:
> - Đang dở:
> - Cạm bẫy phát hiện:
> - Phiên sau làm:
> - Nợ kỹ thuật thêm:
> ```

### 2026-10-22 · `refactor/routes-missions-4` · Đợt 1.4 — **hết endpoint `/api/missions` trong `server.js`**

- **Đã xong:** tách 2 router (`missionsChoXetDuyet.js`, `missionsChiTiet.js`), 11 endpoint,
  −283 dòng. `server.js` còn **18.551 dòng**; tổng Đợt 1 đã cắt **1.285 dòng**.
- **Cạm bẫy phát hiện:**
  - **Vùng 1.4 không liền mạch.** Giữa nó có `PUT/DELETE /api/admin/missions/:id` (thuộc Đợt 6)
    và mount `missionsExport`. Grep theo `'/api/missions` **không bắt** `/api/admin/missions` —
    suýt cắt nhầm route của đợt khác. Từ nay phải grep `^app\.(get|post|…)\(` cho cả vùng rồi mới
    chốt ranh giới.
  - **Bắt buộc 2 router, 2 điểm mount.** Gộp làm một và mount ở vị trí đầu sẽ đẩy `:id` lên trước
    `missionsExport` → `/api/missions/export` bị nuốt thành `:id = "export"` và trả 400. Đã thêm
    test «thứ tự đăng ký» canh đúng chế độ hỏng này.
  - **Nợ #10** — `by-code/:code` không có `authMiddleware`, lộ số liệu kinh phí. Khác nợ #9: ở đây
    bản vá đã rõ và nhiều khả năng an toàn (xem bằng chứng trong bảng nợ).
- **Phiên sau làm:**
  1. Gom `routes/missions*` (7 file) về `routes/missions/` — PR **chỉ di chuyển file**
  2. Vá nợ #10 (một dòng, như PR #7)
  3. Đợt 2 (`crd`, 36 endpoint)
- **Còn treo:** **chưa deploy bản nào lên production** — đã tích 5 PR. Cần hỏi IT: Docker hay PM2,
  và `node --version` trên server.

### 2026-10-22 · `refactor/routes-missions-3` · Đợt 1.3

- **Đã xong:** tách `routes/missions/pheDuyet.js` — 13 endpoint duyệt Bước 4a/4b/5/6 (−337 dòng).
  `server.js` còn **18.834 dòng**, tổng đã cắt 1.002 dòng.
- **Cạm bẫy phát hiện:**
  - `chuTichOrThuyKyOrAdmin` được định nghĩa **ngay giữa khối code cũ** (chỉ dùng cho đúng một
    endpoint `ket-qua-hop`), nên nó di chuyển cùng router và nhận `roleIsAny` qua tham số factory
    thay vì từ phạm vi module của `server.js`.
  - **Nợ #9** — hai endpoint ghi không kiểm phân quyền, xem bảng nợ. Di chuyển nguyên trạng, có
    test ghim hiện trạng.
  - `diff` route-inventory **không phát hiện được việc tuột phân quyền** — nó chỉ so đường dẫn và
    thứ tự, không so middleware. Vì vậy mỗi đợt đều phải tự viết test ranh giới vai trò.
- **Phiên sau làm:** Đợt 1.4 (`cho-ct-hd`, `by-code`, `:id`, hồ sơ ngoài, sản phẩm — ~409 dòng),
  rồi gom `routes/missions*` (6 file) về `routes/missions/` bằng PR chỉ di chuyển file.

### 2026-10-22 · `refactor/routes-missions-2` · Đợt 1.1 + 1.2

- **Đã xong:**
  - Nâng Node 20 → **24.22.1** và `better-sqlite3` 11 → 12.11.1 (PR #5, đóng nợ #1 và #5)
  - **Vá lỗ hổng** `cn-info` thiếu `authMiddleware` (PR #7)
  - **Đợt 1.1** tách `routes/missions/core.js` (PR #6, −320 dòng)
  - **Đợt 1.2** tách `routes/missions/hoSo.js` (PR này, −345 dòng)
  - Đổi tên `REFACTOR` → `archive/refactor-ddd-2026-04` trên remote để gỡ đụng độ tên branch
- **Cạm bẫy phát hiện:**
  - **Đợt 1 phải chia 4 PR** — khối `missions` là 1.431 dòng, gấp 3,5 lần trần ~400
  - `/api/missions/:id` **trả 400 và không gọi `next()`** → mọi route có segment chữ sau
    `/api/missions/` phải đăng ký TRƯỚC nó, nếu không chết im lặng (400 chứ không phải 404)
  - `transporter` là biến `let`; truyền theo giá trị chỉ an toàn vì gán ở dòng ~3412, trước điểm
    mount. `npm test` **không bắt được** lỗi này vì test để `SMTP_*` rỗng
  - `engines` của native module **không** đảm bảo có prebuild — `better-sqlite3` 12.x khai hỗ trợ
    Node 20 nhưng không phát hành prebuild Windows cho bản đó
  - **Kho gói trễ hơn nguồn chính thức**: `winget` và `actions/setup-node` đều chỉ có bản Node cũ
    hơn nodejs.org, khiến sàn bảo mật `>=24.22.1` làm CI đỏ cho tới khi đọc version từ `.nvmrc`
  - Tên branch không được vừa là lá vừa là tiền tố (xem §2.1 kế hoạch)
- **Phiên sau làm:** Đợt 1.3 (bước 4a/4b/5/6, ~348 dòng) → 1.4 → gom `routes/missions*` về
  `routes/missions/` bằng một PR chỉ di chuyển file
- **Còn treo:** chưa deploy bản nào lên production. Cần hỏi IT: chạy Docker hay PM2, và
  `node --version` trên server — nếu còn Node 18/20 thì `npm ci` sẽ dừng với `EBADENGINE`

### 2026-08-15 · `chore/dot-0-ha-tang-refactor` · Đợt 0

- **Đã xong:**
  - `readme/KE-HOACH-REFACTOR.md` — kế hoạch 8 đợt, quy ước đặt tên, bảng slug domain chuẩn
  - `readme/KIEN-TRUC-VA-CAM-BAY.md` — ngữ cảnh dài hạn + cạm bẫy đã biết
  - `readme/REFACTOR-PROGRESS.md` — file này
  - `scripts/route-inventory.js` — **đã viết nhưng CHƯA CHẠY THỬ LẦN NÀO** (máy thiếu Node)
  - Dọn tên: `hệ thống file doxc/` → `templates/hoi-dong-dao-duc/`,
    `Lập biểu mẫu.../` → `templates/cap-vien/`, 2 script một lần → `scripts/`,
    xóa 2 file `.pdf` rác (thực chất là JSON báo lỗi lưu nhầm đuôi)
  - Xóa 6 branch local đã merge; giữ 2 branch `backup/` và 3 branch chưa merge
  - Chốt Node 20 (`engines` + `.nvmrc` + `.npmrc`), sửa script `npm test` cho Node 20
  - **Đã xác thực:** `npm test` 26/26 xanh · `route-inventory.js` cho ra **619 route**, giải mã
    đường dẫn sạch 100% · server khởi động và render được
- **Đang dở:** chưa merge Đợt 0 vào `main`, chưa push
- **Cạm bẫy phát hiện:**
  - Native module + phiên bản Node — xem mục "Sự cố phiên bản Node" ở trên
  - **619 route thật, không phải 360.** Con số 360 chỉ là grep `app.<method>` trong `server.js`
  - **Preview local dùng DB thật và SMTP thật** — xem cảnh báo ở trên
  - 2 thư mục vừa đổi tên **không bị code nào tham chiếu** (đã grep toàn repo) nên di chuyển an toàn
- **Phiên sau làm:** quyết định 3 branch chưa merge (nợ #3) → merge Đợt 0 → bắt đầu Đợt 1
  (`missions`)
- **Nợ kỹ thuật thêm:** toàn bộ mục 1–8 ở bảng trên
