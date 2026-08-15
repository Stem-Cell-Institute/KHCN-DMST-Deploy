# Kế hoạch refactor & quy ước làm việc — KHCN-DMST-Deploy (E-office SCI)

> Tài liệu điều phối. Mọi phiên làm việc (Claude Code hoặc người) **đọc file này trước khi sửa code**.
> Trạng thái từng đợt: xem [REFACTOR-PROGRESS.md](REFACTOR-PROGRESS.md).

---

## 0. Hiện trạng (khảo sát ngày 2026-08-15, commit `3718304`)

| Chỉ số | Giá trị |
|---|---|
| `server.js` | **19.836 dòng**, ~1,04 MB |
| Số endpoint khai báo trực tiếp trong `server.js` | **360** (`app.get/post/put/patch/delete`) |
| Router đã tách ra `routes/` | 14 file |
| Module đã tách kiến trúc lớp | 1 (`modules/document-workflow/`) |
| File `.html` nằm ở thư mục gốc | **49** |
| Lưới an toàn | `tests/smoke.test.js` + `tests/helpers/testServer.js` (đã có) |
| Branch tồn đọng | 10 local / 6 remote, phần lớn đã chết |

### Khối lượng còn lại trong `server.js`, theo nhóm API

| Nhóm | Prefix | Số endpoint | Ghi chú |
|---|---|---|---|
| Quản trị hệ thống | `/api/admin` | 79 | Đụng chạm mọi module → tách **cuối cùng** |
| Hợp tác quốc tế | `/api/cooperation` + `/api/htqt` + `/api/events` | 65 + 6 + 13 = **84** | `routes/ytnn.js` đã tách một phần |
| Đề tài cấp Viện | `/api/cap-vien` | 47 | Có DB riêng (`de-tai-cap-vien.db`) → biên rõ ràng |
| Nhiệm vụ KHCN | `/api/missions` | 40 | Đã tách `missionsExport`, `missionsTemplates` → **tiếp tục cho xong** |
| CRD lab booking | `/api/crd` | 36 | Tự chứa, có frontend bundle riêng |
| Nộp hồ sơ | `/api/submissions` | 20 | Nhỏ, ít phụ thuộc |
| Công bố khoa học | `/api/publications` + `/api/orcid` + `/api/enrich` | 16 | Đã có `pubMod`/`orcidMod` một phần |
| Lõi (auth, health, homepage, users…) | rải rác | ~15 | Giữ lại hoặc đưa vào `routes/core.js` |

**Mục tiêu cuối:** `server.js` < 300 dòng, chỉ còn bootstrap (config → db → middleware → mount router → listen).

---

## 1. Năm nguyên tắc bắt buộc

1. **Refactor không đổi hành vi.** Một đợt tách route là thao tác *cắt–dán + đổi import*. Sửa logic, đổi tên biến, "tiện tay dọn" → làm ở commit khác, PR khác.
2. **Đợt nhỏ.** Mỗi đợt ≤ ~400 dòng di chuyển. Đợt lớn không review được và không rollback được.
3. **Không có test thì không tách.** Trước khi tách nhóm X, phải có smoke test phủ các endpoint chính của X.
4. **Không đổi URL.** Đường dẫn API và đường dẫn file `.html` là hợp đồng với 49 trang frontend + người dùng đang chạy thật trên `eoffice.sci.edu.vn`. Đổi URL là một dự án riêng, không gộp vào refactor.
5. **Một đợt = một branch = một PR = một phiên làm việc.** Không làm hai đợt trong một branch.

---

## 2. Quy ước đặt tên

### 2.1 Luật chung

| Đối tượng | Quy ước | Ví dụ đúng | Ví dụ sai |
|---|---|---|---|
| Thư mục mã nguồn (tầng kiến trúc) | tiếng Anh, thường, một từ | `routes/`, `services/`, `lib/` | `Routes/`, `xu-ly/` |
| Thư mục domain con | `kebab-case`, ASCII, theo **slug chuẩn** ở §2.2 | `routes/cap-vien/` | `routes/capVien/` |
| File JS backend | `camelCase.js` (giữ theo hiện trạng `routes/`) | `dmsRecords.js` | `dms_records.js` |
| File/URL frontend, CSS, ảnh | `kebab-case`, **không dấu tiếng Việt** | `quan-ly-de-tai-co-so.html` | `quản-lý.html` |
| Bảng & cột DB | `snake_case`, giữ nguyên hiện trạng | `cooperation_doan_ra` | — |
| Branch Git | `<type>/<slug-domain>-<mô-tả>`, **ASCII, không dấu** | `refactor/routes-cooperation` | `Chỉnh-màu-cho-Trang-chủ` |
| Phiên Claude Code | **trùng tên branch** | `refactor/routes-crd` | `E-office SCI` |

> **Không dùng dấu tiếng Việt và khoảng trắng trong tên thư mục/file được commit.** Lý do: hỏng khi checkout trên Linux server (deploy đang chạy Linux), hỏng khi encode URL, và `git`/`docker` xử lý không nhất quán giữa Windows và Linux.

### 2.2 Bảng slug domain chuẩn — **nguồn chân lý duy nhất**

Dùng đúng slug này cho: tên thư mục, tên branch, tên file router, prefix API, tên phiên làm việc.

| Domain (tiếng Việt) | **Slug chuẩn** | API prefix hiện tại |
|---|---|---|
| Quản trị hệ thống | `admin` | `/api/admin` |
| Hợp tác quốc tế (đoàn ra/vào, MOU, YTNN, sự kiện) | `cooperation` | `/api/cooperation`, `/api/htqt`, `/api/events` |
| Đề tài cấp Viện | `cap-vien` | `/api/cap-vien` |
| Nhiệm vụ KHCN các cấp | `missions` | `/api/missions` |
| Đặt lịch thiết bị CRD | `crd` | `/api/crd` |
| Nộp & theo dõi hồ sơ | `submissions` | `/api/submissions` |
| Công bố khoa học, ORCID | `publications` | `/api/publications`, `/api/orcid` |
| Thiết bị & tài sản | `equipment` | `/api/equipment*` |
| Văn bản hành chính nội bộ | `documents` | `/api/dms-*`, workflow |
| Lõi: auth, health, trang chủ | `core` | `/api/login`, `/api/me`, … |

> Hiện đang lẫn lộn Việt–Anh (`cap-vien` vs `cooperation`). **Giữ nguyên, không đổi**, vì đổi prefix API = đổi hợp đồng với frontend. Bảng này chốt lại để không sinh thêm biến thể mới.

### 2.3 Cấu trúc thư mục đích

Giữ nguyên các tầng đang có, chỉ **thêm thư mục con theo domain khi một domain vượt 3 file**:

```
KHCN-DMST-Deploy/
├─ server.js                  # đích: < 300 dòng, chỉ bootstrap
├─ CLAUDE.md                  # bộ nhớ dự án cho mọi phiên (xem §5.1)
│
├─ routes/                    # tầng HTTP: parse request, gọi service, trả response
│  ├─ core.js
│  ├─ cooperation/            # tách thư mục con khi domain > 3 file
│  │  ├─ doanRa.js
│  │  ├─ doanVao.js
│  │  ├─ mou.js
│  │  └─ index.js             # gom & export 1 router cho domain
│  ├─ cap-vien/
│  ├─ missions/
│  └─ crd/
│
├─ services/                  # nghiệp vụ thuần, KHÔNG biết req/res
├─ middleware/                # auth, phân quyền, upload
├─ lib/                       # hạ tầng dùng chung: db, config, paths, upload
├─ queries/  db/  migrations/ # SQL
├─ modules/document-workflow/ # module đã có kiến trúc lớp riêng — mẫu tham khảo
│
├─ public/                    # asset tĩnh (css, js, ảnh)
├─ views/                     # EJS
├─ frontend/                  # app build (Vite/esbuild)
├─ templates/                 # ⚠️ gom .docx về đây (xem §2.4)
├─ scripts/                   # CLI, migration, tiện ích
├─ tests/                     # lưới an toàn
└─ readme/                    # tài liệu (file này)
```

**Quy tắc chia lớp** — trả lời "code này để đâu?":

| Câu hỏi | Nếu **đúng** → đặt vào |
|---|---|
| Có đọc `req` / ghi `res` không? | `routes/` |
| Là nghiệp vụ thuần, test được không cần HTTP? | `services/` |
| Chạy trước handler cho nhiều route? | `middleware/` |
| Là hạ tầng, không chứa nghiệp vụ (db, path, config)? | `lib/` |
| Là SQL dài? | `queries/*.sql` |

### 2.4 Việc dọn dẹp tên (làm ở Đợt 0)

| Hiện tại | Đổi thành | Lý do |
|---|---|---|
| `hệ thống file doxc/` | `templates/hoi-dong-dao-duc/` | có dấu tiếng Việt + sai chính tả (`doxc`) |
| `Lập biểu mẫu cho toàn bộ quy trình đề tài cấp Viện/` | `templates/cap-vien/` | có dấu + khoảng trắng |
| `routes/equipmentPart2.js` | gộp vào `routes/equipment/` | `Part2` là tên vô nghĩa, dấu hiệu tách vội |
| `tmp_server_stdout.log`, `tmp_server_stderr.log` | xóa + thêm `tmp_*.log` vào `.gitignore` | rác |
| `1774426940688.pdf`, `1774427055838.pdf` (171 B ở gốc) | xóa | rác |
| `fix-crd-created-at.js`, `test-insert-created-at.js` | chuyển vào `scripts/` | script một lần nằm ở gốc |

> Dùng `git mv` (không phải move ngoài Git) để giữ lịch sử file.

---

## 3. Lộ trình theo đợt

Thứ tự chọn theo: **hoàn tất việc đang dở → nhóm tự chứa → nhóm lớn → nhóm đụng chạm mọi thứ**.

| Đợt | Nội dung | Endpoint | Rủi ro | Điều kiện tiên quyết |
|---|---|---|---|---|
| **0** | Hạ tầng quản lý: `CLAUDE.md`, `REFACTOR-PROGRESS.md`, `scripts/route-inventory.js`, dọn tên §2.4, dọn branch chết | 0 | Rất thấp | — |
| **1** | `missions` — tách nốt 40 endpoint còn lại | 40 | Thấp | Đã có 2 router mẫu |
| **2** | `crd` — module tự chứa | 36 | Thấp | Smoke test cho `/api/crd` |
| **3** | `submissions` + `publications`/`orcid` | 36 | Thấp | — |
| **4** | `cap-vien` — DB riêng, biên rõ | 47 | Trung bình | Smoke test luồng nộp/duyệt |
| **5** | `cooperation` + `htqt` + `events` | 84 | **Cao** | Chia thành 3 PR con theo `doan-ra` / `doan-vao` / `mou` |
| **6** | `admin` | 79 | **Cao** | Làm sau cùng; phụ thuộc mọi domain đã ổn định |
| **7** | `core` + rút gọn `server.js` về bootstrap | ~15 | Trung bình | Tất cả đợt trên xong |

**Ước lượng:** 1 đợt ≈ 1–2 phiên làm việc. Đợt 5 và 6 mỗi đợt ≈ 3–4 phiên.

Sau mỗi đợt: **deploy lên production và theo dõi 48h trước khi bắt đầu đợt kế tiếp.** Không dồn 2 đợt rồi mới deploy — khi có lỗi sẽ không biết đợt nào gây ra.

---

## 4. Công thức chuẩn cho một đợt tách route

Làm đúng 8 bước, không bỏ bước nào:

```bash
# 1. Chụp ảnh danh sách route TRƯỚC khi sửa
node scripts/route-inventory.js > /tmp/routes-before.txt

# 2. Branch mới từ main sạch
git checkout main && git pull && git checkout -b refactor/routes-<slug>
```

3. **Bổ sung smoke test** cho nhóm sắp tách vào `tests/smoke.test.js` → chạy `npm test`, phải **xanh trên code cũ**. (Test viết sau khi tách thì không chứng minh được gì.)

4. **Tạo `routes/<slug>.js`** theo đúng mẫu factory đang dùng — xem `routes/ytnn.js` làm chuẩn:

```js
'use strict';
const express = require('express');

module.exports = function createXxxRouter({ db, authMiddleware /* … */ }) {
  const router = express.Router();
  // … handlers cắt nguyên văn từ server.js
  return router;
};
```

5. **Cắt–dán nguyên văn** handler từ `server.js` sang. Không sửa một dòng logic nào. Thiếu biến/hàm dùng chung → truyền qua tham số factory, **không** `require('../server')`.

6. **Mount** trong `server.js`, giữ **nguyên** prefix và **nguyên** thứ tự middleware:

```js
app.use('/api/<slug>', authMiddleware, require('./routes/<slug>')({ db }));
```

> ⚠️ Thứ tự đăng ký route có ý nghĩa. Trong `server.js` đã có chỗ ghi rõ route tĩnh phải khai báo **trước** route `:id` (xem `server.js:19604`). Giữ nguyên vị trí `app.use` tại đúng chỗ handler cũ nằm.

7. **Kiểm chứng cơ học:**

```bash
node scripts/route-inventory.js > /tmp/routes-after.txt && diff /tmp/routes-before.txt /tmp/routes-after.txt
```

Kết quả **phải rỗng**. Có khác biệt = đã làm mất hoặc đổi endpoint.

```bash
npm test
```

8. **Commit + PR**, mô tả nêu rõ: nhóm nào, bao nhiêu endpoint, `diff` inventory rỗng, `npm test` xanh.

### Định nghĩa "Xong" (Definition of Done) — một đợt chỉ được merge khi đủ 5 điều

- [ ] `diff` route-inventory trước/sau = **rỗng**
- [ ] `npm test` xanh, có test mới cho nhóm vừa tách
- [ ] `server.js` giảm đúng số dòng đã chuyển đi (không phát sinh code mới)
- [ ] Không sửa logic nghiệp vụ trong cùng commit
- [ ] Đã bấm thử tay ≥ 3 màn hình frontend liên quan

### Rollback

Mỗi đợt là một merge commit độc lập → hỏng thì `git revert -m 1 <merge-commit>`. Đây là lý do bắt buộc "một đợt = một PR": revert được nguyên đợt mà không đụng đợt khác.

---

## 5. Quản lý phiên làm việc

Mỗi phiên Claude Code **bắt đầu từ con số 0 về ngữ cảnh**. Ba file dưới đây là bộ nhớ thay thế:

| File | Vai trò | Ai cập nhật |
|---|---|---|
| `CLAUDE.md` | Ngữ cảnh dài hạn: kiến trúc, lệnh chạy, cạm bẫy | Cập nhật khi có phát hiện mới |
| `readme/KE-HOACH-REFACTOR.md` | Kế hoạch & quy ước (file này) | Chỉ đổi khi đổi chiến lược |
| `readme/REFACTOR-PROGRESS.md` | Trạng thái từng đợt + bàn giao phiên | **Mọi phiên, ở cuối phiên** |

### 5.1 `CLAUDE.md` cần chứa gì

Ngắn (< 100 dòng), chỉ những gì không suy ra được từ code:

- Hệ thống là gì, chạy thật ở đâu (`eoffice.sci.edu.vn`)
- Lệnh: `npm start`, `npm test`, `npm run build`
- Kiến trúc 1 đoạn + link tới file này
- **Cạm bẫy đã biết**, ví dụ: `express.static(__dirname)` phục vụ cả thư mục gốc nên đã phải chặn source bằng blocklist (`server.js:19034`); thứ tự route tĩnh trước route `:id`; hai DB tách biệt (`sci-ace.db` và `de-tai-cap-vien.db`)
- Quy tắc: đọc `readme/REFACTOR-PROGRESS.md` trước khi sửa

### 5.2 Vòng đời một phiên

**Đầu phiên** — đặt tên phiên **trùng tên branch** (`refactor/routes-crd`), rồi:
> "Đọc CLAUDE.md và readme/REFACTOR-PROGRESS.md. Làm Đợt N theo §4 của readme/KE-HOACH-REFACTOR.md."

**Trong phiên** — một phiên làm **đúng một đợt**. Phát sinh việc ngoài phạm vi → **ghi vào mục "Nợ kỹ thuật" của PROGRESS**, không làm luôn. Đây là điều quan trọng nhất: refactor hỏng vì phình phạm vi, không phải vì kỹ thuật.

**Cuối phiên** — commit, rồi ghi 5 dòng bàn giao vào `REFACTOR-PROGRESS.md`:

```markdown
### 2026-08-16 · refactor/routes-crd · Đợt 2
- Đã xong: tách 36 endpoint /api/crd sang routes/crd/
- Đang dở: chưa tách phần export Excel (services/crdExport.js)
- Cạm bẫy phát hiện: /api/crd/slots phải đứng trước /api/crd/:id
- Phiên sau làm: mở PR, chạy lại route-inventory
- Nợ kỹ thuật: hàm formatDate lặp ở 4 chỗ
```

Không có bàn giao = phiên sau phải đọc lại 19.836 dòng.

### 5.3 Quy ước phiên & branch

- Tên phiên = tên branch. Sidebar sẽ đọc được ngay đang làm gì (thay vì `E-office SCI`).
- Một phiên chạm nhiều hơn một đợt → **tách phiên mới**.
- Phiên hỏi đáp / tìm hiểu (không sửa code): đặt tên `hoi-<chủ đề>`, không tạo branch.
- **Dọn branch chết ở Đợt 0**: 10 branch local hiện tại đặt tên tiếng Việt có dấu (`Chỉnh-màu-cho-Trang-chủ`, `Xác-thực-email-người-dùng`…). Branch nào đã merge → xóa; chưa merge → đổi tên theo §2.1 hoặc xóa nếu bỏ.

```bash
git branch --merged main          # xem branch đã merge, an toàn để xóa
git branch -d <ten-branch>
```

---

## 6. Rủi ro đã nhận diện

| Rủi ro | Ảnh hưởng | Cách chặn |
|---|---|---|
| Mất endpoint khi cắt–dán | Trang frontend chết im lặng | `scripts/route-inventory.js` + diff bắt buộc |
| Đổi thứ tự route → route `:id` nuốt route tĩnh | 404 hoặc trả sai bản ghi | Giữ nguyên vị trí `app.use`; test route tĩnh |
| Phình phạm vi giữa đợt | PR không review nổi, không revert nổi | Trần 400 dòng/đợt; nợ kỹ thuật ghi ra, không làm luôn |
| Deploy dồn nhiều đợt | Không truy được đợt nào gây lỗi | Deploy + theo dõi 48h sau **mỗi** đợt |
| Chặn truy cập source bằng **blocklist** (`server.js:19034`) | File mới không nằm trong danh sách chặn có thể bị tải về | Ngoài phạm vi refactor — ghi vào Nợ kỹ thuật, xử lý riêng (đổi sang allowlist) |
| Tên file/thư mục có dấu tiếng Việt | Hỏng khi checkout trên server Linux | Dọn ở Đợt 0, §2.4 |

---

## 7. Bắt đầu

Đợt 0 gồm 5 việc, không đụng vào logic nào:

1. Tạo `CLAUDE.md`
2. Tạo `readme/REFACTOR-PROGRESS.md` với bảng 8 đợt
3. Viết `scripts/route-inventory.js`
4. Dọn tên theo §2.4 bằng `git mv`
5. Dọn branch chết

Xong Đợt 0 mới bắt đầu Đợt 1.
