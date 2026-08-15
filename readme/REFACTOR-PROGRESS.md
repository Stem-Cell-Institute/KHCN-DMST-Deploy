# Tiến độ refactor `server.js`

Kế hoạch & quy ước: [KE-HOACH-REFACTOR.md](KE-HOACH-REFACTOR.md)

**Mọi phiên làm việc cập nhật file này ở cuối phiên.** Không có bàn giao = phiên sau phải đọc lại
19.836 dòng.

---

## Bảng đợt

| Đợt | Nhóm | Endpoint | Trạng thái | Branch |
|---|---|---|---|---|
| 0 | Hạ tầng quản lý + dọn tên | 0 | 🔵 Xong, chờ merge | `chore/dot-0-ha-tang-refactor` |
| 1 | `missions` | 40 | ⬜ Chưa bắt đầu | — |
| 2 | `crd` | 36 | ⬜ Chưa bắt đầu | — |
| 3 | `submissions` + `publications` | 36 | ⬜ Chưa bắt đầu | — |
| 4 | `cap-vien` | 47 | ⬜ Chưa bắt đầu | — |
| 5 | `cooperation` + `htqt` + `events` | 84 | ⬜ Chưa bắt đầu | — |
| 6 | `admin` | 79 | ⬜ Chưa bắt đầu | — |
| 7 | `core` + rút `server.js` < 300 dòng | ~15 | ⬜ Chưa bắt đầu | — |

Ký hiệu: ⬜ chưa bắt đầu · 🟡 đang làm · 🔵 chờ review/merge · ✅ đã merge + deploy ổn định

**Số dòng `server.js`:** 19.836 (mốc đầu, commit `3718304`) → *mục tiêu < 300*

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
| 1 | Chặn tải mã nguồn qua `express.static` đang dùng **blocklist** (`server.js:19034`). File mới thêm ở thư mục gốc mà quên khai báo sẽ tải về được. Nên đổi sang allowlist. | Đợt 0 | Bảo mật — nên làm sớm, PR riêng |
| 2 | `routes/equipmentPart2.js` — tên vô nghĩa, dấu hiệu tách vội. Gộp vào `routes/equipment/`. | Đợt 0 | Thấp — làm cùng đợt `equipment` |
| 7 | **`npm test` chưa chạy được trong CI.** `tests/helpers/testServer.js` bắt buộc có `data/sci-ace.db`, mà `data/*.db` bị gitignore (`.gitignore:138`) nên runner không có DB. Cách sửa: tạo DB mẫu chỉ có lược đồ + vài bản ghi giả, commit vào `tests/fixtures/`, cho helper dùng nó khi thiếu DB thật. Cho tới lúc đó `npm test` vẫn phải chạy tay. | Đợt 0 | **Cao — CI chỉ chặn được lỗi cú pháp, chưa chặn được lỗi hành vi** |
| 4 | `data/` còn file backup `.db` cũ trên đĩa (`sci-ace-backup-20260321`, `test-unified.db`…). Đã gỡ khỏi Git và ignore, nhưng vẫn chiếm chỗ. | Đợt 0 | Rất thấp |
| 6 | `npm audit` báo **8 lỗ hổng (6 cao, 2 vừa)**. Đáng chú ý: `multer@1.4.5-lts.2` đã bị khai tử, bản 2.x mới có vá — mà đây là thư viện xử lý **toàn bộ upload** của hệ thống đang chạy thật. | Đợt 0 | **Bảo mật — nên xử lý sớm, PR riêng** |
| 5 | Đợt 0 mới đổi tên **thư mục**; ~40 file `.docx` trong `templates/cap-vien/` và `templates/hoi-dong-dao-duc/` vẫn còn dấu tiếng Việt trong tên (`SCI-FINAL-01__ĐƠN_ĐỀ_NGHỊ_...docx`). Cùng rủi ro checkout trên Linux, nhưng tên này người dùng nhìn thấy khi tải biểu mẫu → **cần quyết định của người dùng**, không tự đổi. | Đợt 0 | Trung bình — cần quyết định |

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

### 2026-08-15 · `chore/dot-0-ha-tang-refactor` · Đợt 0

- **Đã xong:**
  - `readme/KE-HOACH-REFACTOR.md` — kế hoạch 8 đợt, quy ước đặt tên, bảng slug domain chuẩn
  - `CLAUDE.md` — ngữ cảnh dài hạn + cạm bẫy đã biết
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
- **Nợ kỹ thuật thêm:** mục 1–6 ở bảng trên
