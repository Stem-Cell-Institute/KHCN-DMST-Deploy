# Module Báo cáo phòng ban

Trang: `bao-cao-phong.html` · API: `/api/bao-cao-phong/*`

Mã nguồn: `routes/baoCaoPhong.js` (+ `routes/baoCaoPhongVienTruong.js`, `services/baoCaoPhongVienTruong.js`), `services/baoCaoPhongSchema.js`,
`services/baoCaoPhongMau.js`, `services/baoCaoPhongMauMacDinh.js`, `services/baoCaoPhongXuat.js`,
`services/baoCaoPhongThongBao.js`, `services/fonts/`, `public/js/baoCaoPhong.js`,
`public/css/bao-cao-phong.css`.

## Để làm gì

Trưởng phòng Tổ chức Hành chính giao **đợt báo cáo** cho các phòng; mỗi trưởng phòng **nhập báo cáo
trực tiếp trên web** theo một **biểu mẫu do người quản lý tự cấu hình** (mẫu ban đầu lấy từ "Báo cáo
kết quả hoạt động tháng" của Viện); người quản lý **xác nhận** hoặc **yêu cầu chỉnh sửa**, **kết xuất
Word/PDF**, rồi **trình Viện trưởng**: Viện trưởng đọc báo cáo từng phòng ngay trong hệ thống và **duyệt / không duyệt / góp ý / đề nghị chỉnh sửa** từng báo cáo (không tải tệp). Mọi thay đổi trạng thái quan trọng có **email báo**.

## Ba vai trò

Lưu trong bảng riêng `bcp_thanh_vien`, **không đụng vào cột `users.role` dùng chung** toàn hệ thống.

| Vai trò | Làm được gì |
|---|---|
| **Người quản lý module** (`quan_ly`) | Dựng biểu mẫu (nhiều biểu mẫu, nhân bản, xóa biểu mẫu chưa dùng), giao đợt, xem mọi báo cáo, **xác nhận** báo cáo từng phòng, yêu cầu chỉnh sửa, kết xuất Word/PDF, **trình / trình lại đợt cho Viện trưởng**, quản lý danh mục phòng, gán trưởng phòng. Thấy đợt nào đã trình, đợt nào chưa, và Viện trưởng đã xử lý đến đâu. Nhận email khi có phòng nộp báo cáo. **Không** có màn "xem như Viện trưởng" và không duyệt thay. |
| **Viện trưởng** (`vien_truong`) | Chỉ thấy các đợt **đã được trình** (đợt chưa trình với ông như không tồn tại: không danh sách, không tiến độ, không đọc báo cáo, không góp ý, 404). Trong mục **Duyệt báo cáo** đọc báo cáo từng phòng và bấm **Duyệt · Không duyệt · Ý kiến · Đề nghị chỉnh sửa**. **KHÔNG** xác nhận / yêu cầu chỉnh sửa (việc của quản lý), **KHÔNG** kết xuất, **KHÔNG** trình đợt, **KHÔNG** tạo/sửa/mở/đóng/xóa đợt, **KHÔNG** quản lý biểu mẫu, phòng, phân quyền, lời mời (403). Một người giữ cả hai vai trò thì làm được cả hai. Chỉ nhận email khi đợt được trình/trình lại và khi phòng nộp lại đúng báo cáo ông đã đề nghị sửa. |
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

## Chức danh người phụ trách báo cáo của phòng

Một phòng có thể có nhiều người được giao nộp báo cáo. Mỗi người có một **chức danh**: Trưởng phòng, Phó trưởng phòng, Quyền trưởng phòng, Kế toán
(`services/baoCaoPhongChucDanh.js`; giao diện có bản sao nhãn trong `CHUC_DANH` ở `public/js/baoCaoPhong.js`). **Về quyền, mọi chức danh đều là vai trò
`truong_phong`** (cùng thấy báo cáo của phòng, cùng nhập/nộp, cùng nhận thư): chức danh chỉ để ghi rõ người đó là ai và hiện trong bảng phân quyền, thư mời,
thư báo. Lưu ở cột `chuc_danh` của `bcp_thanh_vien` và `bcp_loi_moi` (NULL với vai trò toàn module). DB cũ tự thêm cột khi khởi động, dòng cũ thành Trưởng phòng.
Chọn chức danh ở "Thêm phân quyền" và "Mời người phụ trách phòng bằng email". Một người chỉ có một chức danh trong một phòng. Các thư khác (mở đợt,
nhắc hạn, ý kiến…) vẫn gọi chung là "trưởng phòng".

## Cách nộp khi một phòng có nhiều người phụ trách

Mỗi **đợt** có một trong hai cách nộp (`bcp_dot.cach_nop`), người quản lý module chọn khi tạo đợt:

| Cách nộp | Báo cáo | Phòng hoàn thành khi |
|---|---|---|
| `mot_nguoi` (mặc định, như trước) | **một báo cáo chung** của phòng; ai trong phòng cũng nhập và nộp được | một người đã nộp |
| `tat_ca` | **mỗi người phụ trách một báo cáo riêng** (cùng biểu mẫu), `bcp_bao_cao.chu_id` = người đó | **mọi người** được phân công đã nộp |

Quy tắc của `tat_ca`:
- **Chỉ đổi được cách nộp khi đợt còn Nháp** (báo cáo được dựng lại); đã mở thì 409.
- **Mỗi người chỉ thấy, nhập và nộp báo cáo của mình**; đồng nghiệp cùng phòng không đọc được báo cáo của nhau (404). Người quản lý và Viện trưởng đọc tất cả.
- **Đồng bộ theo người phụ trách hiện tại**: khi mở/mở lại đợt, khi gán người mới (gán trực tiếp, nhận lời mời), người đó có báo cáo riêng; người mới nhận lại báo cáo "chờ giao"
  còn trống nếu có. Khi gỡ một người: báo cáo **chưa nộp** của họ bị bỏ; báo cáo **cần chỉnh sửa** thành "chờ giao" (ai trong phòng cũng nhập được); báo cáo **đã nộp/đã xác nhận** giữ nguyên làm hồ sơ.
  Phòng chưa có ai được phân công có một báo cáo "chờ giao" (`chu_id` rỗng).
- **Tiến độ đếm theo BÁO CÁO** (một phòng có thể có nhiều báo cáo): thư/dải ghi "x/y báo cáo" thay vì "x/y phòng"; trang đợt thêm dòng "Phòng đã hoàn thành báo cáo: x/y" (phòng hoàn thành khi mọi báo cáo của phòng đã nộp).
  Thư báo nộp liệt kê "Báo cáo chưa nộp" kèm tên người. Đợt `mot_nguoi` giữ nguyên cách nói cũ.
- **Thư theo từng báo cáo**: thư mở đợt, nhắc hạn, báo sửa đợt chỉ nêu liên kết báo cáo **của đúng người nhận**; ý kiến của Viện trưởng về một báo cáo riêng chỉ gửi người đó và người quản lý module.
- **Kết xuất** có thêm `?bao_cao=ID,ID` (chọn từng báo cáo); giao diện dùng cách này. `?phong=` vẫn lấy mọi báo cáo của phòng (409 nếu có báo cáo chưa nộp). Tên văn bản kèm người phụ trách ("Phòng A — Họ tên").

Chuyển DB cũ: bảng `bcp_bao_cao` kiểu cũ có `UNIQUE (dot_id, phong_id)` nên **được dựng lại khi khởi động** (tắt khóa ngoại, chép dữ liệu, đổi tên; trong một giao dịch, giữ nguyên lịch sử/ý kiến/nhật ký nhắc),
thêm `chu_id` và chỉ mục duy nhất `(dot_id, phong_id, COALESCE(chu_id,0))`; đợt cũ là `mot_nguoi`. **Nên sao lưu DB trước khi deploy bản này** như mọi lần nâng cấp lược đồ.

## Danh mục phòng: xóa hay ngừng dùng

- **Xóa** (`DELETE /phong/:id`, nút "Xóa" ở mục Phòng & phân quyền) chỉ có với phòng **chưa từng được giao đợt nào** (cột "Số đợt đã giao" = 0, tính cả đợt Nháp).
  Xóa kèm gỡ các trưởng phòng đang gắn với phòng và hủy lời mời đang chờ; **tài khoản của họ không bị xóa**. Phòng đã có đợt: server trả 409,
  giao diện không hiện nút Xóa — vì báo cáo là hồ sơ của phòng, không được mất theo.
- **Ngừng dùng**: phòng không còn được giao ở đợt mới, báo cáo cũ giữ nguyên; "Dùng lại" để bật trở lại.
- **Mã phòng** (`bcp_phong.ma`) không còn hiển thị hay nhập trên giao diện. Cột còn trong DB chỉ để "Nhập từ danh mục đơn vị" khỏi tạo trùng
  phòng đã có; không dùng cho phân quyền, email hay kết xuất.

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

**Ai xác nhận? Chỉ người quản lý module (và admin).** Viện trưởng không xác nhận hộ: ông đọc và duyệt hồ sơ. `/me` có `quan_ly_module` (admin hoặc có dòng `quan_ly`) phân biệt với `quan_ly` (gồm cả Viện trưởng).

**Từ ngữ — hai việc khác nhau, hai từ khác nhau.** *Xác nhận* = người quản lý module kiểm báo cáo của **từng phòng** (trạng thái "Đã xác nhận"). *Duyệt* = **chỉ Viện trưởng**, trên **từng báo cáo**, sau khi đợt được **trình**. Hai việc **độc lập**: Viện trưởng không cần chờ xác nhận, và xác nhận không thay việc duyệt. Tên trạng thái/đường dẫn trong mã vẫn là `da_duyet`, `/duyet` cho phần *xác nhận*.

```
Biểu mẫu ──(ghim phiên bản mới nhất)──▶ Đợt  [Nháp] ─Mở─▶ [Đang mở] ─Đóng─▶ [Đã đóng]   (Mở lại được)

Báo cáo:  Chưa nộp ─Nộp─▶ Đã nộp ─Xác nhận─▶ Đã xác nhận        (xác nhận của quản lý)
   │ ▲         ▲             │                 │
   │ └─Lưu nháp (không khóa)  └─ Cần chỉnh sửa ◀─Yêu cầu sửa (quản lý) / Đề nghị chỉnh sửa (Viện trưởng)

Trình:    quản lý bấm "Trình Viện trưởng" (cả đợt, trình lại nhiều lần được) ─▶ đợt hiện trong mục Duyệt báo cáo của Viện trưởng
Quyết định của Viện trưởng (từng báo cáo đã nộp):  Chờ duyệt ─▶ Duyệt | Không duyệt | Đề nghị chỉnh sửa   (đổi ý được, cả hai nằm trong lịch sử)
```

- **Lưu nháp không khóa**: báo cáo vẫn "Chưa nộp", sửa và lưu lại bao nhiêu lần cũng được. Chỉ **Nộp** mới
  khóa, và mở lại khi người quản lý yêu cầu chỉnh sửa.
- **Nháp** (đợt) ẩn với trưởng phòng; chỉ sau khi **Mở** họ mới thấy. Xóa được đợt chỉ khi còn Nháp.
- Đợt **Đã đóng**: trưởng phòng không nhập/nộp được; muốn yêu cầu sửa phải **mở lại** đợt.
- **Trễ hạn** = chưa nộp mà đã qua ngày hạn, hoặc nộp sau ngày hạn (nên có thể lớn hơn số phòng chưa
  nộp). Tính theo **giờ Việt Nam** (server có thể chạy UTC).
- Mọi chuyển trạng thái nằm ngay trong câu `UPDATE … WHERE trang_thai IN (…)` và kiểm `changes`: hai
  người bấm cùng lúc thì chỉ một người thắng, người kia nhận 409.
- **Chỉ Viện trưởng quyết định, không ai quyết định thay** (quản lý module và admin nhận 403).
- **Trình**: `POST /dot/:id/trinh-vien-truong` (quản lý module/admin). Không có tệp: toàn bộ báo cáo của đợt "kích hoạt" trong giao diện Viện trưởng. **Phòng chưa nộp hoặc trễ hạn vẫn trình được**; Viện trưởng thấy "Chưa nộp". Đợt Nháp thì 409; chưa có Viện trưởng được gán thì 409. Trình lại (nhắc) được bao nhiêu lần cũng được; mỗi lần ghi `trinh`/`trinh_lai` vào lịch sử đợt (bảng `bcp_trinh_lan`).
- **Quyết định**: `POST /bao-cao/:id/quyet-dinh` `{quyet_dinh: duyet|khong_duyet|de_nghi_chinh_sua, ghi_chu, nop_luc}`. Chỉ khi đợt đã trình và báo cáo **đã nộp**. `nop_luc` bắt buộc = bản Viện trưởng đã đọc; lệch (phòng nộp lại trong lúc ông đọc) → 409. Không duyệt và đề nghị chỉnh sửa **bắt buộc có lý do**. Bấm lại đúng quyết định đang có thì bỏ qua.
- **Quyết định không có cột riêng**: suy ra từ `bcp_lich_su` (`vt_duyet`, `vt_khong_duyet`, `vt_de_nghi_chinh_sua`; `services/baoCaoPhongVienTruong.js`). Chỉ áp dụng cho **bản nộp hiện tại**: nộp lại hoặc quản lý yêu cầu chỉnh sửa thì hết hiệu lực. Nhờ vậy cái hiện trên báo cáo và cái ghi trong lịch sử không bao giờ lệch.
- **Ngữ nghĩa**: *Duyệt* / *Không duyệt* **không khóa gì** và không đổi trạng thái xác nhận. *Đề nghị chỉnh sửa* đưa báo cáo về "Cần chỉnh sửa" kèm nội dung; nếu đợt **đã đóng** thì **tự mở lại** (ghi `mo_lai_theo_de_nghi` vào lịch sử đợt; email nhắc quản lý đóng lại khi xong, hệ thống không tự đóng). Duyệt và không duyệt vẫn làm được khi đợt đã đóng nhưng không mở lại đợt.
- **Phòng và quản lý thấy**: trạng thái và lý do của Viện trưởng hiện trong báo cáo (khung "Viện trưởng đã duyệt / không duyệt / đề nghị chỉnh sửa"), trong "Báo cáo của tôi" và cột "Viện trưởng" của bảng tiến độ đợt; mọi quyết định nằm trong lịch sử báo cáo.
- **Chỉ thấy báo cáo đã nộp**: bản nháp của phòng chưa nộp không bao giờ về tới Viện trưởng (`du_lieu` = null).

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
| Quản lý **mở đợt** (lần đầu: Nháp → Đang mở) | trưởng phòng của các phòng được giao (mỗi người một thư; phụ trách nhiều phòng thì một thư liệt kê liên kết từng phòng) | tiêu đề/kỳ đợt, **hạn nộp kèm "còn N ngày"**, biểu mẫu, **liên kết vào đúng báo cáo của phòng họ**. Cố ý **không chép hướng dẫn** của đợt vào thư (xem trong báo cáo) |
| Thêm phòng vào đợt **đã mở** | chỉ trưởng phòng của phòng **mới thêm** | như trên |
| Quản lý **sửa đợt đang mở** (đổi hạn nộp / tiêu đề / hướng dẫn) | trưởng phòng của các phòng **chưa nộp** (chưa nộp hoặc đang cần chỉnh sửa; không gồm phòng đã nộp/đã duyệt, không gồm người vừa sửa; một người một thư) | giá trị **cũ → mới** (hạn nộp kèm "còn N ngày"; đổi hướng dẫn thì chỉ báo "đã được cập nhật", không chép nguyên văn), liên kết vào báo cáo của phòng họ. Đổi hạn thì tiêu đề thư `[Đổi hạn nộp]`, còn lại `[Cập nhật đợt báo cáo]`. Hộp "Gửi email báo…" trong khung Sửa đợt (mặc định bật) cho phép tắt, vd. chỉ sửa chính tả |
| **Tự nhắc trước hạn** (hệ thống tự chạy, không ai bấm) | trưởng phòng của phòng **chưa nộp** hoặc đang **cần chỉnh sửa**, trong đợt **đang mở**; mỗi người một thư dù phụ trách nhiều phòng; không loại ai (nhắc việc) | hạn nộp kèm "còn N ngày", lưu ý nếu đang cần chỉnh sửa, liên kết vào đúng báo cáo. Hai mốc: **còn 1–2 ngày** (`[Nhắc nộp báo cáo]`) và **đúng ngày hạn** (`[Hạn nộp hôm nay]`). Quá hạn thì không nhắc nữa |
| **Viện trưởng gửi ý kiến** về báo cáo của một phòng | trưởng phòng của **chính phòng đó** **và người quản lý module** (trưởng phòng của phòng khác không nhận; quản lý kiêm trưởng phòng nhận một thư; người viết không nhận thư của chính mình) | **nguyên văn ý kiến** + liên kết vào báo cáo; tiêu đề `[Ý kiến của Viện trưởng] <phòng> — <đợt>` |
| Quản lý mời/gán trưởng phòng | người được mời/gán | thư mời + mã (nếu chưa có tài khoản); hoặc thư báo kèm đợt đang mở |
| Quản lý **trình / trình lại** đợt | Viện trưởng | người trình, lời nhắn, **đã nộp x/y**, phòng chưa nộp, liên kết vào mục Duyệt báo cáo. Trình lại: `[Nhắc duyệt]`. Cố ý không nêu số báo cáo đã xác nhận (dễ nhầm với việc duyệt) |
| Viện trưởng **không duyệt / đề nghị chỉnh sửa** một báo cáo | người phụ trách **báo cáo đó** + người quản lý (phòng khác không nhận) | nguyên văn lý do + liên kết; tiêu đề `[Viện trưởng không duyệt]` / `[Viện trưởng đề nghị chỉnh sửa]`; đợt tự mở lại thì có thêm câu nhắc |
| Viện trưởng **duyệt** một báo cáo | **không gửi thư** (phòng thấy trong báo cáo) | — |
| Viện trưởng xử lý xong báo cáo cuối cùng đang chờ | người quản lý (một thư) | `[Viện trưởng đã xử lý]` kết quả duyệt/không duyệt/đề nghị sửa; đổi ý sau đó không gửi lại |
| Phòng nộp lại báo cáo Viện trưởng đã **đề nghị chỉnh sửa** | Viện trưởng | `[Đã chỉnh sửa theo đề nghị]` + liên kết thẳng tới báo cáo |

Dữ liệu người dùng gõ được **escape** trước khi vào HTML thư. Chỉ URL thuộc **chính hệ thống** (cùng
`BASE_URL`) mới được biến thành liên kết bấm được; URL do người dùng gõ (hướng dẫn đợt, lời nhắn) giữ dạng
văn bản thường, để không ai lợi dụng email của hệ thống gửi liên kết lừa đảo. Mở đợt không bao giờ gửi lại khi
**mở lại** đợt đã đóng. Khi bấm "Mở đợt", hộp xác nhận cảnh báo **phòng nào chưa có trưởng phòng** (phòng đó
sẽ không nhận thư; người được gán sau vẫn nhận thư báo các đợt đang mở). Email báo trưởng phòng khi bị **yêu
cầu chỉnh sửa** chưa có. Cần đặt `BASE_URL` để liên kết trong thư
có địa chỉ tuyệt đối; SMTP chưa cấu hình thì module vẫn chạy, chỉ không có thư.

**Cho người nộp báo cáo — "việc của bạn" nổi bật** (người nộp thường không quen công nghệ, không tự đi tìm):
- **Trang chủ** (`public/js/the-bao-cao-phong.js`, nạp từ `index.html`): nếu phòng của người dùng có báo cáo cần nộp /
  chỉnh sửa, thẻ "Báo cáo phòng ban" hiện khung đỏ "Có N báo cáo cần nộp" + hạn + nút **"Làm báo cáo ngay →"** dẫn thẳng vào
  báo cáo (nhiều báo cáo thì dẫn tới "Báo cáo của tôi"). Chỉ gọi `GET /cua-toi`; lỗi/chưa đăng nhập thì thẻ giữ nguyên.
- **Trong module**: "Báo cáo của tôi" hiện **thẻ lớn một nút** cho từng việc (kèm lời nhắn khi bị yêu cầu chỉnh sửa); xong hết thì
  hiện "✓ Phòng bạn đã nộp xong". Tab này có **số việc** và đứng đầu thanh điều hướng khi đang có việc.
- **Quản lý kiêm trưởng phòng** (vd. Trưởng phòng TCHC): mọi màn quản lý có **dải đỏ trên cùng** "Phòng … cần nộp báo cáo" + nút
  to, để việc của chính mình không chìm giữa việc quản lý. Hết việc thì dải tự mất.

**Ý kiến của Viện trưởng về từng báo cáo** (`POST /bao-cao/:id/y-kien`, bảng `bcp_y_kien`): chỉ Viện trưởng gửi được (người khác 403), chỉ khi phòng đã nộp (chưa nộp → 409; đợt Nháp → 409), 1–2000 ký tự. Ý kiến **chỉ thêm, không sửa/xóa**; hiện ở đầu báo cáo cho chủ phòng, người quản lý và Viện trưởng (phòng khác không đọc được báo cáo nên không thấy). Không đổi trạng thái báo cáo. Gửi xong email nguyên văn cho các trưởng phòng của phòng đó; giao diện báo lại "Email đã được gửi tới N trưởng phòng và M người quản lý module" (hoặc nói rõ chưa có ai nhận vì phòng chưa có trưởng phòng); API trả `da_bao` và `da_bao_quan_ly`. Gửi thư lỗi (SMTP hỏng) không làm mất ý kiến.

**Cho Viện trưởng — mục "Duyệt báo cáo"** (`public/js/baoCaoPhongDuyet.js`, `public/css/bao-cao-phong-duyet.css`): thanh điều hướng có số báo cáo chờ duyệt; mở mục luôn ra **trang đầu** (danh sách đợt chờ duyệt kèm số báo cáo, nút "Đọc và duyệt"; không có đợt nào chờ thì nói rõ "Hiện không có báo cáo nào chờ bạn duyệt"). Trong màn đọc: danh sách phòng + bộ lọc, nội dung báo cáo dạng HTML, **thanh thao tác dính ở đáy** (Duyệt một chạm không hỏi lại, rồi tự nhảy sang báo cáo chờ kế tiếp; Không duyệt / Ý kiến / Đề nghị chỉnh sửa mở ô nhập gọn ngay trên thanh), phím tắt J/K, N, D, X, Y, E. Điện thoại: danh sách thu thành một nút chọn phòng, thanh dưới một hàng 64px, bảng xếp thành thẻ. Dữ liệu: `GET /viec-cua-toi` (`dot_duyet`, trang chủ), `GET /tong-quan` (`dot_cho_vien_truong`, `dot_da_trinh`), `GET /dot/:id/vien-truong` (cả đợt trong một lần tải; chỉ Viện trưởng, đợt chưa trình 404).
Mục "Đợt báo cáo" của Viện trưởng đổi tên **"Lịch sử các đợt báo cáo"** (lưu trữ các đợt đã trình); của quản lý là **"Các đợt báo cáo"**, có cột **Trình Viện trưởng** (Đã trình lần N / Chưa trình).

**Trong giao diện — "Cần xử lý"** (`GET /tong-quan`): dải đầu danh sách đợt cho biết bao nhiêu báo cáo
chờ duyệt, bao nhiêu phòng chưa nộp / trễ hạn, bao nhiêu hồ sơ chờ Viện trưởng, kèm **từng đợt đã nộp
x/y**; thanh điều hướng hiện số việc đang chờ riêng người đó.

**Nhắc trước hạn** (`services/baoCaoPhongNhacHan.js`): `server.js` truyền `nhacTuDong: true` nên router hẹn giờ chạy mỗi 30 phút
(lần đầu sau 2 phút kể từ lúc khởi động; timer `unref`, không giữ tiến trình sống). Chỉ gửi trong **giờ làm việc theo giờ Việt Nam
(8h–17h59)** — server có thể chạy UTC. Mỗi (báo cáo, mốc, hạn nộp) nhắc **đúng một lần**: dòng nhật ký `bcp_nhac_han` được "giành" bằng
`INSERT OR IGNORE` trước khi gửi nên chạy chồng hay khởi động lại không nhắc đôi; dời hạn thì hạn mới được nhắc lại từ đầu; nếu mọi thư
đều lỗi (SMTP hỏng) thì nhả dòng ra để lần sau thử lại. Muốn đổi mốc/giờ: hằng `NHAC_TRUOC_NGAY`, `GIO_BAT_DAU`, `GIO_KET_THUC` trong file đó.
Chưa có nút tắt nhắc riêng cho từng đợt.

Sửa đợt: chỉ **đợt đang mở** mới gửi thư (Nháp chưa ai thấy; đã đóng thì hạn nộp không còn ý nghĩa). Mọi lần sửa hạn/tiêu đề/hướng dẫn
của đợt đã mở hoặc đã đóng đều ghi vào **lịch sử đợt** (`sua_dot`, kèm giá trị cũ → mới và "không gửi thông báo" nếu đã tắt). Sửa kỳ,
loại đợt hay thêm phòng không thuộc nhóm này (thêm phòng có thư riêng, xem bảng). `PUT /dot/:id` trả `da_bao` = số người sẽ
nhận thư; giao diện hiện "Đã gửi email báo N trưởng phòng chưa nộp".

## Ai đọc được báo cáo?

- **Người không có vai trò gì trong module: không đọc được gì** (API trả 403/404). Có test.
- **Phòng này không đọc được báo cáo phòng kia**: báo cáo ngoài phạm vi trả **404**, giống hệt id không
  tồn tại — không lộ id nào có thật. Có test (và đã kiểm chứng test bắt được lỗi bằng cách cố ý phá).
- Người đọc được mọi báo cáo: người quản lý, Viện trưởng, admin hệ thống.

## Bảng dữ liệu (tiền tố `bcp_`)

`bcp_phong` · `bcp_thanh_vien` · `bcp_mau` · `bcp_mau_phien_ban` · `bcp_dot` · `bcp_bao_cao` ·
`bcp_lich_su` · `bcp_trinh_lan` · `bcp_dot_lich_su` · `bcp_loi_moi` (+ `bcp_nhac_han`, `bcp_y_kien`). `bcp_trinh` / `bcp_trinh_tep` (hồ sơ tệp của cách làm cũ) **đã bỏ khỏi lược đồ**; DB đã có các bảng này giữ nguyên, không còn dùng. Lược đồ + giải thích:
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

Một dòng trong `server.js` (sau `/ytnn`), sau `authMiddleware`; truyền `db`, `baseUrl`, `mailSend`
(`uploadsRoot` còn được truyền nhưng không dùng nữa). Đường tĩnh (`/phong/nhap-tu-don-vi`, `/tong-quan`) khai báo **trước** đường có `:id`.
`routes/baoCaoPhongVienTruong.js` (trình, đọc cả đợt, quyết định) được gắn vào cùng router chính, không có tiền tố riêng.

## Test

- `baoCaoPhongMau.test.js`, `baoCaoPhongBang.test.js` — logic biểu mẫu, bảng, tổng hợp (thuần).
- `baoCaoPhongXuat.test.js` — mô hình tài liệu (kể cả múi giờ), tệp Word (soi XML), tệp PDF.
- `baoCaoPhongSchema.test.js` — lược đồ, chuyển đổi bảng cũ, ràng buộc.
- `baoCaoPhong.test.js` — tích hợp trên server hộp cát (cổng 3217), trọng tâm ranh giới quyền.
- `baoCaoPhongTrinh.test.js` — vai trò Viện trưởng, email báo nộp, tổng quan, kết xuất Word/PDF qua API; chạy trên router thật + DB `:memory:` + hộp thư giả (`tests/helpers/baoCaoPhongApp.js`).
- `baoCaoPhongDuyetTrongGiaoDien.test.js` — trình và duyệt trong giao diện: quyền, đợt chưa trình ẩn với Viện trưởng, quyết định (nop_luc, đổi ý, không lộ bản nháp), email đúng người/đúng mức, tự mở lại đợt đã đóng, cách nộp mỗi người một báo cáo, thẻ việc, nhiều biểu mẫu.
- `baoCaoPhongMoi.test.js` — mời bằng email (kể cả kịch bản kẻ đăng ký giả email được mời), email mở đợt.
- `baoCaoPhongTuDuyet.test.js` — cờ "tự duyệt" (người nộp = người duyệt), không dính lại sau chỉnh sửa/nộp lại.
- `baoCaoPhongNhacHan.test.js` — nhắc trước hạn: đúng người/đúng mốc/đúng giờ VN, đúng một lần (chạy chồng, khởi động lại, dời hạn), SMTP hỏng.
- `baoCaoPhongYKien.test.js` — ý kiến của Viện trưởng: chỉ Viện trưởng gửi, email đúng phòng, không lộ cho phòng khác, kiểm dữ liệu, SMTP hỏng.
- `baoCaoPhongCachNop.test.js` — cách nộp: mỗi người một báo cáo riêng (riêng tư, đồng bộ người mới/người bị gỡ, thư, kết xuất, ý kiến) và việc dựng lại bảng cũ không mất dữ liệu.
- `baoCaoPhongChucDanh.test.js` — chức danh: gán, mặc định, chức danh lạ, cùng quyền, thư mời/thư báo, nâng cấp DB cũ.
- `baoCaoPhongXoaPhong.test.js` — xóa phòng: chỉ khi chưa từng giao đợt; gỡ trưởng phòng, hủy lời mời, không đụng tài khoản; quyền.
- `baoCaoPhongXacNhan.test.js` — ai xác nhận / tải / gửi / duyệt: Viện trưởng không xác nhận hộ, không tải/gửi hồ sơ; admin và quản lý được; người kiêm hai vai trò làm được cả hai.
- `baoCaoPhongVienTruong.test.js` — dữ liệu thẻ việc: `/viec-cua-toi` (hồ sơ chỉ lộ cho Viện trưởng), `/tong-quan` có đủ thông tin hồ sơ chờ.
- `baoCaoPhongSuaDot.test.js` — email khi sửa đợt đang mở: đúng người nhận, không gửi khi không đổi, tắt được, Nháp/đã đóng.

Đã **kiểm chứng test bắt được lỗi** bằng cách cố ý phá: ranh giới phòng (4 test đỏ), kiểm bản đã đọc `nop_luc` khi quyết định (4), chỉ Viện trưởng quyết định (4), đợt chưa trình ẩn với Viện trưởng (1), không lộ bản nháp của phòng chưa nộp (1), Duyệt không gửi thư cho phòng (2), quyết định hết hiệu lực khi quản lý yêu cầu sửa (1), kiểm email người nhận lời mời (4), giới hạn đuôi
email (1), chỉ liên kết hóa URL của hệ thống (1), lưu băm thay vì mã gốc (1), điều kiện người nhận thư sửa đợt
(phòng đã nộp 4, người vừa sửa 4), chỉ gửi khi đợt đang mở (1), cờ tắt thông báo (1), so sánh người nộp/người duyệt (2).

## Cách xem giao diện không đụng dữ liệu thật

Harness: express + DB `:memory:` + router thật + xác thực giả (chọn người dùng tổng hợp) + hộp thư giả.
Không cần tài khoản hay token nào của hệ thống. Xem PDF thật bằng pdf.js (trình duyệt nhúng trong công
cụ phát triển không hiển thị PDF nội tuyến).

## Chưa làm (cố ý)

- **Chưa email cho trưởng phòng** khi người **quản lý** yêu cầu chỉnh sửa (Viện trưởng đề nghị sửa/không duyệt thì đã có email).
- **Chưa đính kèm tệp vào từng báo cáo phòng.**
- Phần đầu thư (tên Trường/Viện, "Kính gửi Viện trưởng") là **hằng số** trong `baoCaoPhongXuat.js`
  (`CO_QUAN`), chưa chỉnh được trong giao diện.
- Một phòng nhiều trưởng phòng: ai nộp cũng tính là cả phòng nộp (chưa phân biệt trưởng/phó).
