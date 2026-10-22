# Full Spectrum Audit: 49 trang HTML của STIMS

**Ngày**: 22/10/2026
**Chế độ**: Repo Health — phạm vi 49 trang `.html` ở thư mục gốc
**Nguồn**: cây làm việc, nhánh `redesign/trang-chu`
**Lăng kính đã chạy**: 2/10 (Accessibility, UX)
**Lăng kính chưa chạy**: 2 (Repo Maintainer, Production Readiness) — xem mục cuối
**Lăng kính bỏ qua**: 6 — xem bảng lý do

---

## Vì sao bỏ 6 lăng kính

Bộ `audit-suite` được viết cho **một dự án khác**: ứng dụng desktop tên **Orbit** dùng
Tauri + Rust + React + Zustand. Chạy nguyên văn lên một web app Node/Express sẽ cho ra
phát hiện nghe tự tin nhưng lệch hướng. Chính skill cũng có luật bỏ qua.

| Lăng kính | Nguyên văn mô tả | Vì sao bỏ |
|---|---|---|
| Backend Engineer | *"Tauri commands, Rust crates, IPC protocol, sidecar processes"* | Dự án không có Rust/Tauri. Luật của skill: *"skip when no Rust/Tauri changes"* |
| Frontend Engineer | *"React components, hooks, Zustand stores"* | 49 trang này là HTML tĩnh + JS thuần; React chỉ có ở `frontend/document-workflow-ui` |
| Performance Engineer | *"IPC latency, process spawning, desktop apps"* | Web server, không phải desktop |
| DX Engineer | *"**Orbit is a developer tool; its users are developers**"* | Người dùng STIMS là nghiên cứu viên và cán bộ hành chính |
| Structural Engineer | — | Phạm vi này không thêm module nào |
| Design Engineer | — | Đã soi ở lượt trước bằng `impeccable` + `emil-design-engineering` |

---

## Master Verdict: **NEEDS REWORK**

Hệ thống đạt những thứ cơ bản mà nhiều dự án bỏ sót — **49/49 trang** có `<html lang>`,
**49/49** có `meta viewport`, **0** ảnh thiếu `alt`, và 22 trang dùng `<th>` đúng cách
(460 ô tiêu đề bảng). Nền móng không tệ.

Nhưng **361/654 ô nhập liệu (55%) không có tên truy cập được**, và **100 `div`/`span`
mang `onclick`** không thể tới bằng bàn phím. Với một hệ thống hành chính công mà cán bộ
phải nhập liệu hằng ngày, đây là rào chắn thật, không phải lỗi hình thức.

Một hạng mục **đã sửa trong lượt này**: viền focus bàn phím, trước đó chỉ có ở 5/49 trang.

---

## Verdict by Lens

| # | Lăng kính | Verdict | Critical | Khuyến nghị |
|---|---|---|---|---|
| 10 | Accessibility Engineer | **NEEDS REWORK** | 3 | 4 |
| 2 | UX Engineer | **APPROVE WITH CHANGES** | 1 | 3 |

---

## All Critical Issues (Must Fix)

| # | Vấn đề | Lăng kính | Phạm vi | Tác động | Cách sửa |
|---|---|---|---|---|---|
| C1 | **361/654 ô nhập không có tên truy cập được.** Trong đó **286 ô** có `<label>` đứng ngay cạnh nhưng **đóng trước `<input>`** → hai thẻ anh em, không liên kết. 75 ô không có nhãn nào. | A11y, UX | 18 trang; nặng nhất `module-hoatac-quocte.html` (79 ô), `admin-hoatac-quocte.html` (49), `crd-booking-v2.html` (32) | Trình đọc màn hình đọc ra "edit text" trống. Người dùng không biết đang điền gì. Nhãn cũng mất tác dụng mở rộng vùng bấm — ảnh hưởng cả người dùng chuột trên màn hình nhỏ. | Thêm `for=` vào `<label>` khớp `id` của input (86 ô trong dự án đã làm đúng cách này — có mẫu sẵn). Hoặc bọc input vào trong label. |
| C2 | **100 `div`/`span` mang `onclick`** thay vì `<button>` | A11y, UX | 8 trang; `quan-ly-de-tai-co-so.html` (16), `module-hoatac-quocte.html` (15), `task-timeline-FULL.html` (15), `cong-bo-khoa-hoc.html` (22) | Không tới được bằng Tab, không kích hoạt được bằng Enter/Space, trình đọc màn hình không báo là nút. Chức năng **hoàn toàn không dùng được** nếu không có chuột. | Đổi sang `<button type="button">`. Nếu buộc phải giữ `div`, tối thiểu phải có `role="button"` + `tabindex="0"` + xử lý `keydown` cho Enter/Space. |
| C3 | **160 chỗ modal/dialog trên 12 trang, nhưng `aria-expanded` chỉ có ở 1 trang** và không trang nào quản lý focus | A11y | 12 trang | Modal mở ra nhưng focus vẫn ở nền sau. Người dùng bàn phím Tab "xuyên qua" hộp thoại mà không biết. Đóng modal xong focus biến mất. | Khi mở: chuyển focus vào modal, đặt `inert` hoặc bẫy focus ở nền. Khi đóng: trả focus về nút đã mở nó. Cho phép Escape đóng. |

---

## Cross-Cutting Concerns

| Mối lo | Lăng kính phát hiện | Gốc rễ | Cách sửa thống nhất |
|---|---|---|---|
| **Giao diện được xây bằng `div` + `onclick` + `style=` nội tuyến thay vì phần tử ngữ nghĩa** — 100 div-onclick, 1.818 thuộc tính `style=` trên 43 trang, 788 emoji thay icon trên 37 trang | A11y, UX | Không có hệ thành phần dùng chung. Mỗi trang tự dựng lại nút, ô nhập, thẻ từ đầu bằng HTML thô. | Rút một bộ thành phần tối thiểu (nút, trường nhập có nhãn, hộp thoại) vào `public/css/` + partial dùng chung, rồi chuyển dần từng trang. Đây là việc nhiều đợt, không phải một PR. |
| **Cập nhật động không được thông báo** — `aria-live` chỉ có ở 8/49 trang, trong khi hầu hết trang đều nạp dữ liệu bằng `fetch` rồi vẽ lại DOM | A11y, UX | Mặc định "thấy là biết" | Thêm một vùng `aria-live="polite"` cho thông báo trạng thái (đang tải / đã lưu / lỗi) vào partial dùng chung. |

---

# Lens Reports

---

## 10. Accessibility Engineer

**Verdict**: **NEEDS REWORK**

### Phương pháp

Không đọc tay 49 trang (bất khả thi và dễ chọn mẫu thiên lệch). Thay vào đó quét cơ học
toàn bộ, rồi **kiểm chứng lại từng con số đáng ngờ** trên trình duyệt thật.

Một đính chính trong chính lượt audit này: lượt quét đầu báo "374 ô thiếu nhãn", nhưng
regex đó không phân biệt được `<label>text <input></label>` (hợp lệ) với
`<label>text</label><input>` (không liên kết). Quét lại cho con số đúng là **361**, và
quan trọng hơn là **cơ cấu** của nó.

### Files Reviewed

| Nhóm | Số trang | Vai trò a11y | Rủi ro |
|---|---|---|---|
| Biểu mẫu nhập liệu nghiệp vụ | 18 | Nhập dữ liệu đề tài, hồ sơ, đặt lịch | **Cao** |
| Bảng điều khiển / danh sách | 23 | Tra cứu, lọc, xuất báo cáo | Trung bình |
| Xác thực (đăng nhập/đăng ký) | 5 | Cổng vào hệ thống | **Cao** |
| Tĩnh / hướng dẫn | 3 | Đọc | Thấp |

### Critical Issues

Xem C1, C2, C3 ở bảng tổng hợp.

### Recommendations

| # | Vấn đề | Tiêu chí WCAG | Cách sửa |
|---|---|---|---|
| R1 | **`:focus-visible` chỉ có ở 5/49 trang.** Nhiều trang còn chủ động xoá bằng `outline: none` trong `<style>` nội tuyến | 2.4.7 Focus Visible, 2.4.11 Focus Appearance | ✅ **ĐÃ SỬA** — thêm `public/css/a11y.css`, nạp vào cả 49 trang |
| R2 | `prefers-reduced-motion` chỉ có ở 3/49 trang | 2.3.3 Animation from Interactions | ✅ **ĐÃ SỬA** — cùng file trên |
| R3 | **`@media (hover: hover)` không có ở trang nào (0/49).** Trên cảm ứng, `:hover` dính lại sau khi chạm | — (khả dụng) | Đã sửa cho `trang-chu.css`. 48 trang còn lại cần làm dần. |
| R4 | **Liên kết bỏ qua điều hướng chỉ có ở 3/49 trang.** `<main>` thiếu ở 12 trang | 2.4.1 Bypass Blocks | Đã có sẵn lớp `.skip-link` trong `a11y.css`; từng trang cần thêm thẻ `<a class="skip-link">` và `id="main"` |

### Nice-to-Haves

| # | Gợi ý | Lý do |
|---|---|---|
| N1 | 17 trang có nhảy cấp heading (h2 → h4), 3 trang có nhiều hơn một `<h1>`, 2 trang không có `<h1>` nào (`crd-booking-v2.html`, `de-xuat-chi-tiet.html`) | Trình đọc màn hình dùng danh sách heading để nhảy nhanh. `module-hoatac-quocte.html` có **12 thẻ `<h1>`** — mất hẳn tác dụng phân cấp |
| N2 | 788 emoji thay cho icon trên 37 trang | Trình đọc màn hình đọc tên Unicode đầy đủ ("khoá có móc") giữa câu. Và emoji hiển thị khác nhau theo hệ điều hành |
| N3 | 28 `<a href="#">` trên 15 trang | Link giả. Nếu là hành động thì phải là `<button>` |

### Kết quả đo được (toàn bộ 49 trang)

| Hạng mục | Kết quả |
|---|---|
| `<html lang>` | **49/49** ✅ |
| `meta viewport` | **49/49** ✅ |
| `<img>` thiếu `alt` | **0** ✅ |
| Bảng có `<th>` | 22 trang / 460 ô ✅ |
| Ô nhập có tên truy cập được | **293/654** ❌ |
| `div`/`span` có `onclick` | **100** ❌ |
| Nút chỉ-icon thiếu nhãn | **30** ❌ |
| `:focus-visible` | 5/49 → **49/49** ✅ (đã sửa) |
| `prefers-reduced-motion` | 3/49 → **49/49** ✅ (đã sửa) |
| `@media (hover: hover)` | 0/49 → 1/49 |
| `aria-live` | 8/49 ❌ |
| `<main>` | 37/49 |
| Liên kết bỏ qua điều hướng | 3/49 ❌ |

### Verdict Details

- Screen Reader Compatibility: **CONCERNS** — 55% ô nhập không có tên
- Keyboard Navigation: **CONCERNS** — 100 điều khiển không tới được bằng Tab
- Focus Management: **CONCERNS** — modal không quản lý focus; viền focus đã sửa
- Color Contrast: **PASS** cho trang chủ (đã đo 129 phần tử, 0 chỗ dưới sàn). 48 trang còn lại chưa đo.
- Motion Sensitivity: **PASS** (sau khi sửa)

---

## 2. UX Engineer

**Verdict**: **APPROVE WITH CHANGES**

Đây là hệ thống đang chạy thật với người dùng thật, nên đánh giá theo "có dùng được
không", không theo "có đúng chuẩn không".

### User Journey Map — luồng nộp hồ sơ đề tài

| Bước | Hành động | Phản hồi hệ thống | Đánh giá |
|---|---|---|---|
| 1 | Vào trang chủ, tìm module | Thẻ module có mô tả và số liệu | **OK** — rõ ràng |
| 2 | Bấm "Truy cập" | Chuyển trang | **OK** |
| 3 | Điền biểu mẫu | Nhãn hiện cạnh ô (nhưng không liên kết — xem C1) | **WARN** — dùng được bằng mắt, hỏng với trình đọc màn hình |
| 4 | Tải tệp lên | — | **WARN** — chưa rà chỉ báo tiến trình |
| 5 | Gửi | — | **WARN** — `aria-live` chỉ có ở 8/49 trang, nên kết quả gửi có thể chỉ hiện bằng mắt |
| 6 | Theo dõi tiến trình | Trang theo dõi riêng | **OK** |

### Critical Issues

| # | Vấn đề | Bước | Tác động | Cách sửa |
|---|---|---|---|---|
| U1 | **Nhãn không liên kết với ô nhập** (C1) cũng là vấn đề UX, không chỉ a11y: bấm vào chữ nhãn **không** đưa con trỏ vào ô. Trên điện thoại, vùng bấm mất đi một nửa. | 3 | Gõ nhầm ô, nhất là trên màn hình nhỏ | Như C1 |

### Recommendations

| # | Vấn đề | Tác động | Cách sửa |
|---|---|---|---|
| U2 | Vùng chạm dưới 44px rải rác — link tin trong dải chạy chỉ **32px** | Khó bấm trên điện thoại | Nợ #13 |
| U3 | 160 chỗ modal trên 12 trang | Modal cắt luồng. Một số chỗ có thể hiển thị tại chỗ | Rà lại từng chỗ: modal chỉ nên dành cho xác nhận hành động không hoàn tác được |
| U4 | `aria-live` 8/49 — thông báo "đã lưu"/"lỗi" có thể chỉ hiện bằng mắt | Người dùng không chắc thao tác đã thành công | Thêm vùng thông báo trạng thái dùng chung |

### Interaction Consistency Check

Không có hệ thành phần dùng chung: 43/49 trang dùng `style=` nội tuyến (1.818 chỗ), mỗi
trang tự dựng lại nút và ô nhập. Hệ quả là cùng một thao tác có thể trông và hành xử khác
nhau giữa các trang. Đây là gốc rễ của phần lớn phát hiện ở cả hai lăng kính.

### Verdict Details

- Discoverability: **PASS** — trang chủ liệt kê module rõ ràng
- Flow Completeness: **PASS** — luồng nộp hồ sơ đi được từ đầu tới cuối
- Error Recovery: **CONCERNS** — chưa rà kỹ thông báo lỗi
- Feedback & Status: **CONCERNS** — `aria-live` 8/49
- Consistency: **CONCERNS** — không có hệ thành phần dùng chung

---

## 6. Repo Maintainer

**Chưa chạy** — hết phạm vi của lượt này. Dữ liệu đã thu sẵn và đáng chú ý: **1.818**
thuộc tính `style=` nội tuyến trên 43 trang, **49 trang `.html` nằm phẳng ở thư mục gốc**,
không có partial hay hệ thành phần dùng chung. Đề nghị chạy riêng.

## 7. Production Readiness

**Chưa chạy** — hết phạm vi. Nhưng phiên này đã phát hiện sẵn một số điểm liên quan, đã
ghi ở bảng Nợ kỹ thuật của `readme/REFACTOR-PROGRESS.md`: chặn tải mã nguồn bằng blocklist
(#4), `multer` 1.x đã khai tử (#3), CI chưa chạy được `npm test` (#2), và **9 PR đã merge
mà chưa deploy lên production**.

---

## Đã sửa trong lượt audit này

| Hạng mục | Trước | Sau |
|---|---|---|
| `:focus-visible` | 5/49 trang | **49/49** |
| `prefers-reduced-motion` | 3/49 trang | **49/49** |
| Lớp `.skip-link` dùng chung | không có | có (từng trang cần tự thêm thẻ) |

Thực hiện bằng `public/css/a11y.css`, nạp vào cả 49 trang ngay sau thẻ `viewport`.

**Ghi chú về `!important`:** file này dùng `!important` **có chủ đích**. Lượt kiểm đầu cho
thấy quy tắc không `!important` **bị thua**: `dang-nhap.html` có
`.form-group input:focus { outline: none }` trong `<style>` nội tuyến, đặc hiệu hơn
(0,2,1 so với 0,1,1) và đứng sau. Mà đó chính là lỗi cần sửa. Sàn tiếp cận phải thắng,
nếu không file này vô dụng. Chỉ áp cho `:focus-visible` nên bấm chuột vẫn không ra viền.

Đã kiểm chứng trên trình duyệt thật: bấm vào ô Email rồi Tab sang ô Mật khẩu →
`:focus-visible` khớp, `outline` tính ra `solid 3px rgb(183, 40, 30)`, viền đỏ son hiện rõ.
