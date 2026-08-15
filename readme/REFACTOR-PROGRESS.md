# Tiến độ refactor `server.js`

Kế hoạch & quy ước: [KE-HOACH-REFACTOR.md](KE-HOACH-REFACTOR.md)

**Mọi phiên làm việc cập nhật file này ở cuối phiên.** Không có bàn giao = phiên sau phải đọc lại
19.836 dòng.

---

## Bảng đợt

| Đợt | Nhóm | Endpoint | Trạng thái | Branch |
|---|---|---|---|---|
| 0 | Hạ tầng quản lý + dọn tên | 0 | 🟡 Đang làm | `chore/dot-0-ha-tang-refactor` |
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

## 🚨 Đang vướng

**Máy `D:\KHCN-DMST Deploy` chưa cài Node.js.** `node` và `npm` không có trong PATH, registry không
có bản cài nào. Hệ quả: **không chạy được `npm test` và `scripts/route-inventory.js` trên máy này**,
tức là hai lưới an toàn của toàn bộ kế hoạch refactor đều chưa dùng được.

`node_modules/` đã cài sẵn và `better_sqlite3.node` đã build, nên nhiều khả năng thư mục này được
copy từ máy khác hoặc Node đã bị gỡ.

**Phải xử lý trước Đợt 1:** cài Node.js (khớp phiên bản production), rồi chạy:

```bash
npm test
node scripts/route-inventory.js > routes-baseline.txt
```

`routes-baseline.txt` là mốc gốc để mọi đợt sau đối chiếu. Chưa có nó thì chưa được bắt đầu Đợt 1.

---

## Nợ kỹ thuật

Việc phát hiện dọc đường nhưng **cố ý không làm** để giữ phạm vi từng đợt.

| # | Việc | Phát hiện ở | Mức |
|---|---|---|---|
| 1 | Chặn tải mã nguồn qua `express.static` đang dùng **blocklist** (`server.js:19034`). File mới thêm ở thư mục gốc mà quên khai báo sẽ tải về được. Nên đổi sang allowlist. | Đợt 0 | Bảo mật — nên làm sớm, PR riêng |
| 2 | `routes/equipmentPart2.js` — tên vô nghĩa, dấu hiệu tách vội. Gộp vào `routes/equipment/`. | Đợt 0 | Thấp — làm cùng đợt `equipment` |
| 3 | 3 branch chưa merge treo từ tháng 4: `Xác-thực-email-người-dùng` (1 commit, tính năng thật), `Chỉnh-sửa-giao-diện-Trang-chủ` (4 commit), `REFACTOR` (1 commit "chỉnh DDD hoàn thiện"). Phải quyết định merge hay bỏ **trước Đợt 5** — để muộn hơn thì `server.js` đã đổi chỗ hết, không merge nổi. | Đợt 0 | Trung bình — chặn tiến độ |
| 4 | `data/` còn file backup `.db` cũ trên đĩa (`sci-ace-backup-20260321`, `test-unified.db`…). Đã gỡ khỏi Git và ignore, nhưng vẫn chiếm chỗ. | Đợt 0 | Rất thấp |
| 5 | Đợt 0 mới đổi tên **thư mục**; ~40 file `.docx` trong `templates/cap-vien/` và `templates/hoi-dong-dao-duc/` vẫn còn dấu tiếng Việt trong tên (`SCI-FINAL-01__ĐƠN_ĐỀ_NGHỊ_...docx`). Cùng rủi ro checkout trên Linux, nhưng tên này người dùng nhìn thấy khi tải biểu mẫu → **cần quyết định của người dùng**, không tự đổi. | Đợt 0 | Trung bình — cần quyết định |

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
- **Đang dở:** chưa xác thực `route-inventory.js`; chưa dọn branch
- **Cạm bẫy phát hiện:**
  - Máy này **không có Node.js** — xem mục "Đang vướng"
  - 2 thư mục vừa đổi tên **không bị code nào tham chiếu** (đã grep toàn repo) nên di chuyển an toàn
- **Phiên sau làm:** cài Node → chạy `npm test` → chạy `route-inventory.js`, sửa nếu lỗi → tạo
  `routes-baseline.txt` → dọn branch → merge Đợt 0
- **Nợ kỹ thuật thêm:** mục 1–4 ở bảng trên
