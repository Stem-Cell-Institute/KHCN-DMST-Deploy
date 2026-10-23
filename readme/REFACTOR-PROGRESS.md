# Tiến độ refactor `server.js`

Kế hoạch & quy ước: [KE-HOACH-REFACTOR.md](KE-HOACH-REFACTOR.md)

**Mọi phiên làm việc cập nhật file này ở cuối phiên.** Không có bàn giao = phiên sau phải đọc lại
19.836 dòng.

---

## Bảng đợt

| Đợt | Nhóm | Endpoint | Trạng thái | Branch |
|---|---|---|---|---|
| 0 | Hạ tầng quản lý + dọn tên | 0 | ✅ Đã merge (`96ec09b`, PR #3) | ~~`chore/dot-0-ha-tang-refactor`~~ đã xóa |
| 1 | `missions` — **chia 4 PR** (khối 1.431 dòng, gấp 3,5 lần trần) | 40 | 🔵 **4/4 — PR cuối chờ review** | xem bảng dưới |
| └ 1.1 | `stats`, danh sách, tạo mới | 3 | ✅ Đã merge (`931e1b0`, PR #6) · −320 dòng | ~~`refactor/routes-missions-1`~~ |
| └ 1.2 | `files`, `cn-info`, bước 2–3, `reset-ve-buoc3` | 13 | ✅ Đã merge (`1fe9748`, PR #8) · −345 dòng | ~~`refactor/routes-missions-2`~~ |
| └ 1.3 | bước 4a / 4b / 5 / 6 | 13 | ✅ Đã merge (`500975a`, PR #9) · −337 dòng | ~~`refactor/routes-missions-3`~~ |
| └ 1.4 | `cho-ct-hd` + `by-code`, `:id`, hồ sơ ngoài, sản phẩm — **2 router** | 11 | 🔵 Chờ review (PR 1.4) · −283 dòng | `refactor/routes-missions-4` |

**Sau Đợt 1: `server.js` không còn endpoint `/api/missions` nào.** 40 endpoint đã nằm trong 7 file
`routes/missions*`. Việc còn lại của Đợt 1 là gom chúng về `routes/missions/` bằng một PR **chỉ di
chuyển file** (theo §2.3 kế hoạch — domain đã vượt 3 file).

**Thứ tự mount bắt buộc trong `server.js`** (đừng đổi, đừng gộp):

```
missionsCore        /missions/stats
missionsHoSo
missionsPheDuyet
missionsChoXetDuyet /missions/cho-ct-hd-*
missionsExport      /missions/export*, /missions/report-excel
missionsChiTiet     /missions/:id          ← PHẢI SAU CÙNG trong nhóm này
missionsTemplates   /missions-templates    (segment khác, không va chạm)
```
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
| ~~1~~ | ✅ **ĐÃ XỬ LÝ** — toàn bộ repo đã chuyển sang **Node 24** (Node 20 hết hỗ trợ bảo mật 30/04/2026, theo endoflife.date): `Dockerfile` `node:24-bookworm-slim`, `engines` `>=24.22.1 <25`, `.npmrc` `engine-strict`, CI đọc `.nvmrc`, `DEPLOY-GUIDE.md` ghi Node 24. **Còn một việc không kiểm được từ repo:** xác nhận máy chủ production thật sự đang chạy Node 24 (`node --version` trên server, hoặc image đã build từ Dockerfile hiện tại). | Đợt 0 | ✅ Đã xử lý (còn xác nhận runtime thật) |
| 2 | **`npm test` chưa chạy được trong CI.** `tests/helpers/testServer.js` bắt buộc có `data/sci-ace.db`, mà `data/*.db` bị gitignore (`.gitignore:138`) nên runner không có DB. Cách sửa: tạo DB mẫu chỉ có lược đồ + vài bản ghi giả, commit vào `tests/fixtures/`, cho helper dùng nó khi thiếu DB thật. Cho tới lúc đó `npm test` vẫn phải chạy tay. | Đợt 0 | **Cao — CI chỉ chặn được lỗi cú pháp, chưa chặn được lỗi hành vi** |
| 3 | **`npm audit` — đã xử lý phần sửa được, còn 5 mục cần quyết định.** Khi rà lại (chỉ phần production) có **14 lỗ hổng, trong đó 1 critical** (`proxy-addr`, gián tiếp qua express) — nhiều hơn con số 8 ghi lúc đầu. Đã làm: (a) `npm audit fix` — chỉ cập nhật `package-lock.json` trong khoảng phiên bản đã khai báo, **hết critical**, 14 → 5; (b) `multer` 1.4.5-lts.2 → **2.5.0** (1.x đã khai tử). Đã kiểm: cùng một request multipart với tên file tiếng Việt cho ra **cùng kết quả** ở multer 1 và 2 (đều latin1, `decodeUploadedFilename` khôi phục đúng cả hai), một upload thật qua server vẫn tới handler, `npm test` 42/42.<br><br>**Còn lại — cố ý chưa làm:**<br>• **`nodemailer` 6.10.1 → 10.x (high)** — nhảy 4 bản major trên đường gửi email Hội đồng; môi trường test để `SMTP_*` rỗng nên không thử được việc gửi thật. Cần thử với SMTP thật hoặc Mailpit trước khi nâng. Rủi ro khai thác thấp hơn vẻ ngoài: địa chỉ nhận lấy từ DB, nội dung do hệ thống sinh.<br>• **`xlsx` (high)** — **không có bản vá trên npm** (SheetJS đã rút khỏi npm, bản vá chỉ phát hành từ cdn.sheetjs.com). Cần quyết định: nạp từ nguồn ngoài đó, hay đổi sang `exceljs` (đã có sẵn) cho phần đọc/ghi Excel.<br>• **`csv-parse` 6 → 7 (moderate)** — bản nâng major, dùng ở import SJR/ORCID; cần thử lại các luồng import.<br>• `exceljs`/`uuid` (moderate) — npm đề xuất "sửa" bằng cách **hạ** exceljs xuống 3.4.0; đó là một bản hạ cấp, **không làm**. | Đợt 0 | **Bảo mật — critical đã hết; còn 2 high cần quyết định** |
| 4 | Chặn tải mã nguồn qua `express.static` đang dùng **blocklist** (`server.js:19034`). File mới thêm ở thư mục gốc mà quên khai báo sẽ tải về được. Nên đổi sang allowlist. | Đợt 0 | Bảo mật — nên làm sớm, PR riêng |
| ~~5~~ | ✅ **ĐÃ XỬ LÝ** — `readme/DEPLOY-GUIDE.md` đã ghi **Node v24 LTS** (v18 và v20 hết vòng đời), cài qua nodesource `setup_24.x`. Mục "Upgrade app" nay dùng `npm ci --omit=dev`, kèm backup trước và kiểm tra `/public/vendor/chart.umd.js` sau deploy. | Đợt 0 | ✅ Đã xử lý |
| 6 | ~40 file `.docx` trong `templates/cap-vien/` và `templates/hoi-dong-dao-duc/` vẫn còn dấu tiếng Việt trong tên (`SCI-FINAL-01__ĐƠN_ĐỀ_NGHỊ_...docx`). Đợt 0 mới chỉ đổi tên **thư mục**. Cùng rủi ro checkout trên Linux, nhưng tên này người dùng nhìn thấy khi tải biểu mẫu → **cần quyết định của người dùng**, không tự đổi. | Đợt 0 | Trung bình — cần quyết định |
| 7 | `routes/equipmentPart2.js` — tên vô nghĩa, dấu hiệu tách vội. Gộp vào `routes/equipment/`. | Đợt 0 | Thấp — làm cùng đợt `equipment` |
| 8 | `data/` còn file backup `.db` cũ trên đĩa (`sci-ace-backup-20260321`, `test-unified.db`…). Đã gỡ khỏi Git và ignore, nhưng vẫn chiếm chỗ. | Đợt 0 | Rất thấp |
| **9** | **Hai endpoint ghi không kiểm phân quyền.** `POST /api/missions/:id/buoc4a/cn-upload-thuyet-minh-chinh-sua` và `POST /api/missions/:id/buoc5/upload-thuyet-minh` chỉ có `authMiddleware` — **không kiểm vai trò, không kiểm chủ nhiệm đề tài**. Bất kỳ tài khoản đã đăng nhập nào, kể cả **`crd_user`** (tài khoản ngoài chỉ để đặt lịch phòng thí nghiệm), đều gọi được cho **mission id bất kỳ**: đánh dấu `thuyet_minh_chinh_sua_ok = 1` và kích hoạt email gửi cả danh sách Hội đồng, hoặc chèn bản ghi vào `buoc5_thuyet_minh_ls`. Đã di chuyển **nguyên trạng** ở Đợt 1.3 (refactor không được đổi hành vi) và có test ghim hiện trạng trong `tests/smoke.test.js`.<br><br>**Vì sao chưa vá:** cần quyết định nghiệp vụ — ai được upload? Chỉ chủ nhiệm, hay chủ nhiệm + thư ký? Và `missions.principal` là **tên dạng chuỗi**, không phải khóa ngoại tới `users`, nên không so khớp quyền sở hữu bằng một middleware được. Khác hẳn lỗ hổng `cn-info` (PR #7) vốn chỉ là quên một dòng.<br><br>**Giảm nhẹ:** cả hai chỉ mở trong một cửa sổ trạng thái quy trình (`thong_qua_co_chinh_sua`, hoặc đề tài đang ở Bước 5) và cần `file_id` hợp lệ của file đã upload trước đó. | Đợt 1.3 | **Bảo mật — quyền ghi, cần quyết định chính sách** |
| ~~10~~ | ✅ **ĐÃ VÁ** — `GET /api/missions/by-code/:code` nay có `authMiddleware`. Trước đó nó trả về toàn bộ bản ghi đề tài (`budget`, `approved_budget`, `disbursed_budget`, `contract_number`, `funding_source`) cho bất kỳ ai biết mã, mà mã sinh theo mẫu `DT-<2 chữ>-<năm>-<4 số>` nên dò được. Kiểm chứng trên server thật: không token **404 → 401**. Có 2 test canh không cho lỗ hổng quay lại. | Đợt 1.4 | ✅ Đã xử lý |
| ~~11~~ | ✅ **ĐÃ VÁ** — 3 trang (`admin-dashboard-demo.html`, `admin-quan-ly-tai-khoan.html`, `admin-system-logs-monitor.html`) không còn nạp `cdn.tailwindcss.com`. CSS nay build sẵn ra `public/css/tailwind.css` bằng `npm run build:css`. **Từ đây frontend không còn script ngoài nào** — CSP `script-src self` không chặn gì nữa. | Sửa Chart.js CSP | ✅ Đã xử lý |

---

## Thư viện ngoài và CSP

`server.js` đặt CSP `script-src self unsafe-inline unsafe-eval` (xem `mountSecurityHeaders`), **không có
nguồn ngoài**. Mọi `<script src="https://…">` đều bị trình duyệt chặn — trên cả máy dev lẫn production,
vì cùng một `server.js`.

### Chart.js — phục vụ nội bộ từ node_modules

5 trang `.html` + `views/ytnn/dashboard.ejs` nạp Chart.js 4.4.1 từ `cdn.jsdelivr.net` nên **biểu đồ không
vẽ được**. Đã chuyển sang phục vụ nội bộ, **không nới lỏng CSP**:

- `chart.js@4.4.1` vào `dependencies` (ghim đúng bản, không dùng `^`) — `npm ci --omit=dev` của
  `Dockerfile` vẫn cài, nên production có file.
- Route `GET /public/vendor/chart.umd.js` trả file từ `node_modules`, đặt cạnh hai route sẵn có
  `/public/vendor/xlsx.full.min.js` và `/public/vendor/Sortable.min.js` — **theo đúng tiền lệ**, không
  commit file thư viện vào repo.

**Đã nâng trần `.github/server-js-max-lines` 18.551 → 18.562** vì route mới thêm 11 dòng vào
`server.js`. Guardrail này là bánh cóc chỉ cho phép file ngắn đi, nhưng đây là **vá lỗi production**,
không phải refactor — nâng trần là cố ý và nằm trong diff để review thấy. Cách khác (gom 3 route
`/public/vendor/*` vào `routes/vendorAssets.js`, server.js giảm ~14 dòng) là việc của một đợt riêng,
không gộp vào commit vá lỗi.

**Cạm bẫy:** URL cũ là `…/dist/chart.umd.min.js`, nhưng gói npm **không có file `.min.js`** — chỉ có
`dist/chart.umd.js` (205 KB, đã minify sẵn). jsDelivr tự minify khi file `.min.js` không tồn tại, nên URL
CDN vẫn chạy. Đừng "sửa" đường dẫn nội bộ thành `.min.js`: sẽ 404.

Kiểm chứng trên localhost:3000 — cả 6 trang nạp được Chart.js 4.4.1, mọi `<canvas>` đều có instance,
console sạch lỗi CSP của Chart.js. Trang Thiết bị (có dữ liệu thật) vẽ ra hình rõ ràng; Dashboard công bố
và YTNN khởi tạo đúng nhưng **chưa có gì để vẽ** vì bảng `publications` đang 0 bản ghi (3.233 bản ghi còn
nằm ở `publication_queue` chờ duyệt) — là tình trạng dữ liệu, không phải lỗi nạp thư viện.

### Tailwind — phải build, không nạp thẳng được

`cdn.tailwindcss.com` (Play CDN) **không phải thư viện mà là trình biên dịch JIT chạy trong trình
duyệt**: nó đọc class trong DOM rồi sinh CSS tại chỗ. Vì vậy không thể bê về `node_modules` rồi phục
vụ nội bộ như Chart.js — phải build CSS tĩnh:

- `tailwindcss` `^3.4.17` vào **devDependencies**, khớp bản mà `frontend/document-workflow-ui` đang
  dùng. Dockerfile chạy `npm ci --omit=dev` nên production **không** cài gói này — không sao, vì file
  CSS đã build sẵn và commit vào repo.
- Cấu hình ở `scripts/tailwind.config.js`, nguồn ở `scripts/tailwind.input.css`. Đặt trong `scripts/`
  vì `express.static` phục vụ cả thư mục gốc, mà `scripts/` đã nằm trong danh sách chặn tải — file mới
  thêm ở gốc thì tải về được (xem nợ #4). Đã kiểm: `GET /scripts/tailwind.config.js` → **403**.
- `npm run build:css` → `public/css/tailwind.css` (25,7 KB đã minify). Đã gắn vào `npm run build`.
  Build **tái lập được**: chạy hai lần cho ra file có cùng sha256.
- 3 trang đổi từ `<script src="https://cdn.tailwindcss.com">` + khối `tailwind.config` nội tuyến sang
  một thẻ `<link rel="stylesheet" href="/public/css/tailwind.css">`. Cấu hình nội tuyến cũ
  (`fontFamily: Inter`, bảng màu `brand`) đã chuyển nguyên vào `scripts/tailwind.config.js`.

**Vì sao đổi được an toàn:** Tailwind quét **văn bản thô** của file nên bắt được cả class nằm trong
chuỗi JS; 3 trang này lại không ghép tên class động (`'bg-' + mau`) nên không có class nào lọt lưới.
Đã kiểm trên trình duyệt: đối chiếu **toàn bộ class dùng trong DOM** với các rule CSS đã nạp —
154/174/241 class, **không thiếu rule nào**. Vài tên như `btn-reset`, `content-section` không có rule,
nhưng đó là **móc cho JS** (`closest('.btn-reset')`), trước nay vốn không có style.

**Nếu sửa class trên 3 trang này thì phải chạy lại `npm run build:css`** — khác CDN cũ tự biên dịch
lúc chạy. Class mới mà quên build thì sẽ không có style.

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

- **Đã xong:** tách `routes/missionsPheDuyet.js` — 13 endpoint duyệt Bước 4a/4b/5/6 (−337 dòng).
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
  - **Đợt 1.1** tách `routes/missionsCore.js` (PR #6, −320 dòng)
  - **Đợt 1.2** tách `routes/missionsHoSo.js` (PR này, −345 dòng)
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
