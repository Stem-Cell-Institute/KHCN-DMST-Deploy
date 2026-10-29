# Module Báo cáo phòng ban

Trang: `bao-cao-phong.html` · API: `/api/bao-cao-phong/*`

Mã nguồn: `routes/baoCaoPhong.js` (+ `routes/baoCaoPhongTrinh.js`), `services/baoCaoPhongSchema.js`,
`services/baoCaoPhongMau.js`, `services/baoCaoPhongMauMacDinh.js`, `services/baoCaoPhongXuat.js`,
`services/baoCaoPhongThongBao.js`, `services/fonts/`, `public/js/baoCaoPhong.js`,
`public/css/bao-cao-phong.css`.

## Để làm gì

Trưởng phòng Tổ chức Hành chính giao **đợt báo cáo** cho các phòng; mỗi trưởng phòng **nhập báo cáo
trực tiếp trên web** theo một **biểu mẫu do người quản lý tự cấu hình** (mẫu ban đầu lấy từ "Báo cáo
kết quả hoạt động tháng" của Viện); người quản lý **duyệt** hoặc **yêu cầu chỉnh sửa**, **kết xuất
Word/PDF**, rồi **trình Viện trưởng** duyệt. Mọi thay đổi trạng thái quan trọng có **email báo**.

## Ba vai trò

Lưu trong bảng riêng `bcp_thanh_vien`, **không đụng vào cột `users.role` dùng chung** toàn hệ thống.

| Vai trò | Làm được gì |
|---|---|
| **Người quản lý module** (`quan_ly`) | Dựng biểu mẫu, giao đợt, xem mọi báo cáo, duyệt, yêu cầu chỉnh sửa, kết xuất Word/PDF, trình Viện trưởng, **duyệt thay Viện trưởng**, quản lý danh mục phòng, gán trưởng phòng. Nhận email khi có phòng nộp báo cáo. |
| **Viện trưởng** (`vien_truong`) | Có **mọi quyền của người quản lý** (được xếp vào module "luôn"), cộng thêm là **người nhận hồ sơ trình** và người duyệt hồ sơ đó. Chỉ nhận email khi hồ sơ được trình lên (không nhận thư mỗi lần một phòng nộp). |
| **Trưởng phòng** (`truong_phong`, gắn một phòng) | Chỉ thấy và nhập báo cáo **của phòng mình**. |

- Admin hệ thống mặc nhiên là người quản lý.
- Chỉ **admin hệ thống** cấp/gỡ vai trò *người quản lý* và *Viện trưởng* (không ai tự nhân bản quyền
  của mình, và không tự chỉ định người duyệt). Người quản lý gán/gỡ *trưởng phòng* thì được.
- **Tự duyệt**: một người có thể vừa là quản lý/Viện trưởng vừa là trưởng phòng (vd. trưởng phòng TCHC), nên có
  thể nộp rồi tự duyệt báo cáo phòng mình. Chính sách đã chọn là **cho phép nhưng ghi rõ**: lịch sử dùng hành
  động riêng `tu_duyet`, trang báo cáo hiện khung "Tự duyệt", danh sách đợt có nhãn "Tự duyệt", nút đổi
  thành "Tự duyệt báo cáo". Không có cột riêng: cờ suy ra từ `nguoi_nop_id = nguoi_duyet_id` khi đang
  `da_duyet`, nên yêu cầu chỉnh sửa/nộp lại/người khác duyệt thì cờ tự hết. Chưa ghi vào tệp Word/PDF xuất ra.
- **`users.role = 'vien_truong'` (vai trò chung của hệ thống) KHÔNG tự cho quyền ở đây**: phải được
  gán rõ trong module. Có test canh điều này.
- **Người quản lý không nhập hộ** báo cáo — chỉ chủ phòng mới nhập, để luôn rõ "ai khai".
- Người được gán/mời phải dùng email `@sci.edu.vn` (cùng điều kiện đăng ký tài khoản). Ô tìm người chỉ
  tìm trong người đã có tài khoản; người **chưa có** thì dùng "Mời trưởng phòng bằng email" (mục sau).

## Mời trưởng phòng bằng email

Người quản lý nhập email @sci.edu.vn + chọn phòng (`POST /loi-moi`):

- **Đã có tài khoản eoffice** → gán làm trưởng phòng ngay, gửi thư báo (kèm các đợt đang mở của phòng).
- **Chưa có tài khoản** → tạo lời mời chờ (hiệu lực 14 ngày) và gửi thư hướng dẫn 3 bước: đăng ký tài khoản
  bằng đúng email đó → đăng nhập, mở module → nhập **mã lời mời** (32 ký tự trong thư). Mở bằng liên kết
  `?moi=<mã>` trong thư thì mã được điền sẵn và thử nhận luôn.
- Người quản lý thấy danh sách lời mời đang chờ, có **Gửi lại** (cấp mã mới, mã cũ mất hiệu lực) và **Hủy**.

**Vì sao phải có mã, không tự gắn quyền cho ai đăng ký email được mời:** đăng ký tài khoản của hệ thống
(`POST /api/register`) **không xác minh quyền sở hữu email** — ai gõ `ten@sci.edu.vn` cũng đăng ký và đăng
nhập được ngay. Nếu lời mời tự gắn vào tài khoản mới thì kẻ đăng ký trước sẽ chiếm quyền trưởng phòng. Mã
được gửi tới CHÍNH hộp thư được mời nên chỉ người đọc được hộp thư đó mới nhận được quyền; và vẫn phải đăng
nhập bằng đúng email đó. Các lớp bảo vệ (đều có test, và đã kiểm chứng test bắt được lỗi bằng cách cố ý phá):

- Mã ngẫu nhiên 128 bit, **chỉ lưu dạng băm sha256** (lộ DB không lộ mã dùng được), **dùng một lần**.
- Nhận mã cần **cả** mã đúng **và** đang đăng nhập bằng đúng email được mời: kẻ có mã nhưng khác email → 403.
- Mã sai/đã dùng/hết hạn/đã hủy cùng một thông báo chung (không cho kẻ đoán phân biệt được).
- Chỉ mời được vai trò **trưởng phòng** (quyền thấp nhất, một phòng). Quản lý/Viện trưởng chỉ gán cho người đã
  có tài khoản — danh tính chưa xác minh không nên được trao quyền xem toàn bộ.
- Danh sách lời mời không bao giờ trả mã hay mã băm.

Người vừa **đăng ký** xong mà chưa nhập mã thì **chưa có quyền gì** ("Bạn chưa được cấp quyền" + ô nhập mã).

## Luồng nghiệp vụ

```
Biểu mẫu ──(ghim phiên bản mới nhất)──▶ Đợt  [Nháp] ─Mở─▶ [Đang mở] ─Đóng─▶ [Đã đóng]
                                         │                    │                │
                                         └─ mỗi phòng một báo cáo ─┘     (Mở lại được)

Báo cáo:  Chưa nộp ─Nộp─▶ Đã nộp ─Duyệt─▶ Đã duyệt
   │ ▲         ▲             │                 │
   │ └─Lưu nháp (không khóa)  └─ Cần chỉnh sửa ◀─Yêu cầu sửa
   └─ sửa/lưu nháp bao nhiêu lần cũng được       (trưởng phòng sửa rồi Nộp lại)

Hồ sơ trình Viện trưởng (mỗi đợt một hồ sơ):
   Chưa gửi ─Gửi─▶ Đã gửi ─Duyệt─▶ Đã duyệt          (Thu hồi: Đã gửi → Chưa gửi, nếu chưa duyệt)
   (tải/xóa tệp được)  (khóa tệp)   (Viện trưởng duyệt, HOẶC quản lý duyệt thay — ghi rõ)
```

- **Lưu nháp không khóa**: báo cáo vẫn "Chưa nộp", sửa và lưu lại bao nhiêu lần cũng được. Chỉ **Nộp** mới
  khóa, và mở lại khi người quản lý yêu cầu chỉnh sửa.
- **Nháp** (đợt) ẩn với trưởng phòng; chỉ sau khi **Mở** họ mới thấy. Xóa được đợt chỉ khi còn Nháp.
- Đợt **Đã đóng**: trưởng phòng không nhập/nộp được; muốn yêu cầu sửa phải **mở lại** đợt.
- **Trễ hạn** = chưa nộp mà đã qua ngày hạn, hoặc nộp sau ngày hạn (nên có thể lớn hơn số phòng chưa
  nộp). Tính theo **giờ Việt Nam** (server có thể chạy UTC).
- Mọi chuyển trạng thái nằm ngay trong câu `UPDATE … WHERE trang_thai IN (…)` và kiểm `changes`: hai
  người bấm cùng lúc thì chỉ một người thắng, người kia nhận 409.
- **Duyệt thay Viện trưởng**: người duyệt không phải Viện trưởng → hồ sơ ghi `duyet_thay = 1`, giao
  diện hiện "duyệt THAY", và Viện trưởng nhận email để không bị bất ngờ.
- Gửi hồ sơ cần ≥ 1 tệp **và** ≥ 1 Viện trưởng đã được gán (nếu không: 409 kèm lý do).

## Biểu mẫu tùy chỉnh

Người quản lý dựng ở mục **Biểu mẫu**. Các loại ô: `text`, `textarea`, `number` (min/max), `date`,
`select`, `checkbox`, `section` (tiêu đề nhóm), và hai loại cho báo cáo dạng mẫu Viện:

- **`bang`** — bảng nhiều dòng. Mỗi cột có loại riêng (văn bản, số, ngày, chọn…); tối đa 8 cột, 100
  dòng. Tùy chọn **cho phép chia nhóm** (dòng tiêu đề A, B, C…) và đặt tên gọi nhóm. Một cột có thể
  được đánh dấu **"Mức độ hoàn thành (%)"** (chỉ cột Số, tối đa một cột/bảng).
- **`tong_hop`** — số liệu **tự tính** từ các bảng được chọn: tổng số việc / hoàn thành (≥100%) /
  đang thực hiện (1–99%) / chưa thực hiện (0% hoặc trống). **Không lưu**: luôn tính lại từ các dòng
  của bảng nên không bao giờ lệch (bản Word gốc từng ghi số lệch nhau). Dòng chưa ghi % tính là chưa
  thực hiện — có ghi chú ngay trên giao diện.

Thuật toán tính nằm ở `services/baoCaoPhongMau.js#tinhTongHop` và có **bản sao** trong
`public/js/baoCaoPhong.js#tinhTongHopClient` (để hiện số liệu ngay khi gõ). **Hai nơi phải khớp nhau.**

**Mẫu ban đầu** (`services/baoCaoPhongMauMacDinh.js`) tái hiện mẫu Word của Viện: tổng quan, hai bảng
công việc (thường xuyên có nhóm; đột xuất), thống kê tự động, tự đánh giá A/B/C, tồn đọng & kiến nghị,
kế hoạch tháng tới. Nạp **một lần** khi chưa có biểu mẫu nào; sau đó mẫu trong DB mới là bản đang dùng
— sửa file này không đổi mẫu đã nạp.

**Mỗi lần sửa cấu trúc = một phiên bản MỚI, bất biến** (`bcp_mau_phien_ban`); mỗi đợt **ghim** đúng
phiên bản lúc tạo. Nên sửa biểu mẫu chỉ áp dụng cho đợt tạo SAU, và báo cáo đã nộp luôn hiển thị đúng
như lúc nộp. Gửi lại đúng cấu trúc cũ thì không sinh phiên bản mới.

Dữ liệu báo cáo lưu JSON theo `key` ô; **chỉ giữ các `key` nằm trong biểu mẫu**. Dữ liệu bảng:
`[ { nhom: "…" }, { o: { cot: giaTri } } ]` (dòng nhóm và dòng dữ liệu tách bằng khóa `nhom`/`o`).

## Kết xuất Word / PDF

`GET /api/bao-cao-phong/dot/:id/xuat?phong=3,5|tat-ca&dinh_dang=docx|pdf[&xem=1]` (người quản lý/Viện trưởng).

- Chọn **một hoặc nhiều phòng**; nhiều phòng gộp một tệp, mỗi phòng một văn bản bắt đầu ở trang mới,
  đánh số trang lại từ 1. `phong=tat-ca` = mọi phòng đã nộp.
- Chỉ xuất báo cáo **đã nộp / đã duyệt**. Chọn đích danh phòng chưa nộp → 409 nêu tên phòng (không
  lặng lẽ bỏ qua).
- Bố cục theo mẫu Viện: quốc hiệu, ngày, tiêu đề, **"Kính gửi: Viện trưởng Viện Tế bào gốc"** (căn trái, chỉ "Kính
  gửi:" in đậm — đã đối chiếu XML file Word gốc), các mục, bảng, khối chữ ký. Phần thân đi
  theo biểu mẫu nên mẫu do người quản lý tự dựng vẫn xuất được. Ngày in theo giờ Việt Nam.
- `xem=1` (PDF): mở thẳng trong trình duyệt để xem trước thay vì tải về.
- Mỗi lần xuất được ghi vào lịch sử đợt (ai, định dạng, phòng nào).
- Thiết kế hai tầng: `dungMoHinh()` (thuần logic, test được) → `taoDocx()` / `taoPdf()` chỉ vẽ. Word
  và PDF luôn cùng nội dung.

**PDF phụ thuộc font nhúng** `services/fonts/Tinos-*.ttf` (SIL OFL, xem `services/fonts/README.md`):
font mặc định của PDF không có dấu tiếng Việt, và image `node:24-bookworm-slim` không có font nào. Thư
viện: `pdfkit@0.20.2` (MIT, thêm 19 gói gián tiếp; `npm audit` không đổi so với trước khi thêm).
Giới hạn đã biết: ô văn bản cao hơn một trang bị **cắt kèm dấu …** trong PDF (Word không giới hạn).

## Thông báo

**Email** (dùng chung SMTP của server — `transporter`/`getSmtpFrom()` trong `server.js`), gửi RIÊNG từng
người, chạy nền, **không bao giờ làm hỏng thao tác chính** (SMTP lỗi → chỉ ghi log):

| Sự kiện | Người nhận | Nội dung chính |
|---|---|---|
| Phòng nộp / nộp lại báo cáo | người quản lý (không gồm người vừa nộp, không gồm Viện trưởng) | phòng nào, người nộp, giờ, **đã nộp x/y phòng**, **phòng nào chưa nộp**, hạn, liên kết. Đủ phòng → tiêu đề `[Đã đủ báo cáo]` |
| Quản lý **mở đợt** (lần đầu: Nháp → Đang mở) | trưởng phòng của các phòng được giao (mỗi người một thư; phụ trách nhiều phòng thì một thư liệt kê liên kết từng phòng) | tiêu đề/kỳ đợt, **hạn nộp kèm "còn N ngày"**, biểu mẫu, hướng dẫn của người quản lý, **liên kết vào đúng báo cáo của phòng họ** |
| Thêm phòng vào đợt **đã mở** | chỉ trưởng phòng của phòng **mới thêm** | như trên |
| Quản lý **sửa đợt đang mở** (đổi hạn nộp / tiêu đề / hướng dẫn) | trưởng phòng của các phòng **chưa nộp** (chưa nộp hoặc đang cần chỉnh sửa; không gồm phòng đã nộp/đã duyệt, không gồm người vừa sửa; một người một thư) | giá trị **cũ → mới** (hạn nộp kèm "còn N ngày"), liên kết vào báo cáo của phòng họ. Đổi hạn thì tiêu đề thư `[Đổi hạn nộp]`, còn lại `[Cập nhật đợt báo cáo]`. Hộp "Gửi email báo…" trong khung Sửa đợt (mặc định bật) cho phép tắt, vd. chỉ sửa chính tả |
| Quản lý mời/gán trưởng phòng | người được mời/gán | thư mời + mã (nếu chưa có tài khoản); hoặc thư báo kèm đợt đang mở |
| Quản lý gửi hồ sơ trình | Viện trưởng | tệp đính kèm, lời nhắn, tiến độ các phòng, liên kết |
| Viện trưởng duyệt | người quản lý | nhận xét |
| Quản lý **duyệt thay** | người quản lý khác **và Viện trưởng** | nêu rõ là duyệt thay |

Dữ liệu người dùng gõ được **escape** trước khi vào HTML thư. Chỉ URL thuộc **chính hệ thống** (cùng
`BASE_URL`) mới được biến thành liên kết bấm được; URL do người dùng gõ (hướng dẫn đợt, lời nhắn) giữ dạng
văn bản thường, để không ai lợi dụng email của hệ thống gửi liên kết lừa đảo. Mở đợt không bao giờ gửi lại khi
**mở lại** đợt đã đóng. Khi bấm "Mở đợt", hộp xác nhận cảnh báo **phòng nào chưa có trưởng phòng** (phòng đó
sẽ không nhận thư; người được gán sau vẫn nhận thư báo các đợt đang mở). Email báo trưởng phòng khi bị **yêu
cầu chỉnh sửa** chưa có. Cần đặt `BASE_URL` để liên kết trong thư
có địa chỉ tuyệt đối; SMTP chưa cấu hình thì module vẫn chạy, chỉ không có thư.

**Trong giao diện — "Cần xử lý"** (`GET /tong-quan`): dải đầu danh sách đợt cho biết bao nhiêu báo cáo
chờ duyệt, bao nhiêu phòng chưa nộp / trễ hạn, bao nhiêu hồ sơ chờ Viện trưởng, kèm **từng đợt đã nộp
x/y**; thanh điều hướng hiện số việc đang chờ riêng người đó.

Sửa đợt: chỉ **đợt đang mở** mới gửi thư (Nháp chưa ai thấy; đã đóng thì hạn nộp không còn ý nghĩa). Mọi lần sửa hạn/tiêu đề/hướng dẫn
của đợt đã mở hoặc đã đóng đều ghi vào **lịch sử đợt** (`sua_dot`, kèm giá trị cũ → mới và "không gửi thông báo" nếu đã tắt). Sửa kỳ,
loại đợt hay thêm phòng không thuộc nhóm này (thêm phòng có thư riêng, xem bảng). `PUT /dot/:id` trả `da_bao` = số người sẽ
nhận thư; giao diện hiện "Đã gửi email báo N trưởng phòng chưa nộp".

## Hồ sơ trình Viện trưởng — bảo mật tệp

Tệp do người quản lý tải lên (bản kết xuất đã chỉnh/đã ký). Đây là chỗ dễ sai nhất của module:

- Chỉ nhận `.pdf`, `.docx`, `.doc` **và kiểm byte đầu** khớp loại (đổi đuôi không qua được); ≤ 25 MB, ≤ 10 tệp/đợt.
- Lưu dưới **tên ngẫu nhiên** (32 hex) trong `<UPLOADS>/bao-cao-phong/<id đợt>/`; tên người dùng đặt chỉ
  ở DB để hiển thị → không có path traversal. Truy cập tệp còn kiểm lại `ten_luu` khớp mẫu hex.
- Không nằm trong thư mục phục vụ tĩnh; chỉ tải qua endpoint (sau `canQuanLy`), kèm `nosniff` + `no-store`.
- **Trưởng phòng không tải được** hồ sơ này (đó là bộ báo cáo gộp nhiều phòng).
- Xóa tệp là xóa đồng bộ trước khi trả lời, nên không có khoảnh khắc "bị từ chối mà tệp còn trên đĩa".

## Ai đọc được báo cáo?

- **Người không có vai trò gì trong module: không đọc được gì** (API trả 403/404). Có test.
- **Phòng này không đọc được báo cáo phòng kia**: báo cáo ngoài phạm vi trả **404**, giống hệt id không
  tồn tại — không lộ id nào có thật. Có test (và đã kiểm chứng test bắt được lỗi bằng cách cố ý phá).
- Người đọc được mọi báo cáo: người quản lý, Viện trưởng, admin hệ thống.

## Bảng dữ liệu (tiền tố `bcp_`)

`bcp_phong` · `bcp_thanh_vien` · `bcp_mau` · `bcp_mau_phien_ban` · `bcp_dot` · `bcp_bao_cao` ·
`bcp_lich_su` · `bcp_trinh` · `bcp_trinh_tep` · `bcp_dot_lich_su` · `bcp_loi_moi`. Lược đồ + giải thích:
`services/baoCaoPhongSchema.js`.

- `CREATE TABLE IF NOT EXISTS`, **không `ALTER` bảng của module khác** — chạy lại an toàn. Riêng
  `bcp_thanh_vien` có bước **chuyển đổi** nếu gặp bảng kiểu cũ chưa có `vien_truong` (SQLite không sửa
  `CHECK` tại chỗ nên dựng lại bảng, giữ nguyên dữ liệu) — có test.
- `foreign_keys` bật toàn cục; mọi tham chiếu `users` dùng `SET NULL`/`CASCADE` để không chặn xóa tài khoản.
- Lỗi khởi tạo lược đồ → server vẫn lên, riêng module này trả 503.

## Thẻ ở trang chủ

Mô-đun có thẻ "Báo cáo phòng ban" trên trang chủ (`index.html`, mã `department_reports`, bật mặc định) như các
mô-đun khác; admin ẩn/hiện/sắp xếp được qua cơ chế sẵn có của trang chủ. Thẻ **không hiện số liệu** (khác thẻ
"Quy trình văn bản"): trang chủ là trang công khai còn số liệu báo cáo phòng ban là nội bộ. Bấm "Truy cập" tới
`bao-cao-phong.html`, trang này tự chuyển về đăng nhập nếu chưa đăng nhập. Thêm thẻ chỉ cần một dòng trong
`HOMEPAGE_MODULES_DEFAULT` (server.js) — `ensureAllHomepageModulesExist` và `repairHomepageModulesCorruption` tự thêm
dòng DB và nối mã vào thứ tự kéo-thả đã lưu.

## Mount và thứ tự route

Một dòng trong `server.js` (sau `/ytnn`), sau `authMiddleware`; truyền `db`, `uploadsRoot`, `baseUrl`,
`mailSend`. Đường tĩnh (`/phong/nhap-tu-don-vi`, `/tong-quan`) khai báo **trước** đường có `:id`.
Router con hồ sơ trình mount ở `/dot/:id/trinh` với `canQuanLy`.

## Test

- `baoCaoPhongMau.test.js`, `baoCaoPhongBang.test.js` — logic biểu mẫu, bảng, tổng hợp (thuần).
- `baoCaoPhongXuat.test.js` — mô hình tài liệu (kể cả múi giờ), tệp Word (soi XML), tệp PDF.
- `baoCaoPhongSchema.test.js` — lược đồ, chuyển đổi bảng cũ, ràng buộc.
- `baoCaoPhong.test.js` — tích hợp trên server hộp cát (cổng 3217), trọng tâm ranh giới quyền.
- `baoCaoPhongTrinh.test.js` — vai trò Viện trưởng, email, hồ sơ trình, tệp, kết xuất qua API; chạy trên
  router thật + DB `:memory:` + hộp thư giả (`tests/helpers/baoCaoPhongApp.js`).
- `baoCaoPhongMoi.test.js` — mời bằng email (kể cả kịch bản kẻ đăng ký giả email được mời), email mở đợt.
- `baoCaoPhongTuDuyet.test.js` — cờ "tự duyệt" (người nộp = người duyệt), không dính lại sau chỉnh sửa/nộp lại.
- `baoCaoPhongSuaDot.test.js` — email khi sửa đợt đang mở: đúng người nhận, không gửi khi không đổi, tắt được, Nháp/đã đóng.

Đã **kiểm chứng test bắt được lỗi** bằng cách cố ý phá: ranh giới phòng (4 test đỏ), kiểm byte đầu
của tệp (4), quyền hồ sơ trình (2), cờ duyệt thay (1), kiểm email người nhận lời mời (4), giới hạn đuôi
email (1), chỉ liên kết hóa URL của hệ thống (1), lưu băm thay vì mã gốc (1), điều kiện người nhận thư sửa đợt
(phòng đã nộp 4, người vừa sửa 4), chỉ gửi khi đợt đang mở (1), cờ tắt thông báo (1), so sánh người nộp/người duyệt (2).

## Cách xem giao diện không đụng dữ liệu thật

Harness: express + DB `:memory:` + router thật + xác thực giả (chọn người dùng tổng hợp) + hộp thư giả.
Không cần tài khoản hay token nào của hệ thống. Xem PDF thật bằng pdf.js (trình duyệt nhúng trong công
cụ phát triển không hiển thị PDF nội tuyến).

## Chưa làm (cố ý)

- **Chưa email cho trưởng phòng** khi bị **yêu cầu chỉnh sửa**, và chưa có **nhắc sắp hết hạn** (đã có email khi mở đợt).
- **Chưa đính kèm tệp vào từng báo cáo phòng** (tệp hiện chỉ ở hồ sơ trình của đợt).
- Phần đầu thư (tên Trường/Viện, "Kính gửi Viện trưởng") là **hằng số** trong `baoCaoPhongXuat.js`
  (`CO_QUAN`), chưa chỉnh được trong giao diện.
- Một phòng nhiều trưởng phòng: ai nộp cũng tính là cả phòng nộp (chưa phân biệt trưởng/phó).
