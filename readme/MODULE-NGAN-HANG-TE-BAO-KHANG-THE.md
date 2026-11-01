# Module Ngân hàng tế bào & Kháng thể

Trang: `public/ngan-hang-te-bao-khang-the/index.html` (địa chỉ ngắn `/ngan-hang-te-bao-khang-the`) ·
API: `/api/ngan-hang-te-bao-khang-the/*` (86 route)

Mã nguồn: `routes/nganHangTeBaoKhangThe/` (`index.js`, `boiCanh.js`, `khoLuuTru.js`, `danhMuc.js`, `thanhVien.js`, `sinhVien.js`,
`timKiem.js`, `yeuCau.js`, `phatHien.js`, `mau.js`), `services/nganHangTeBaoKhangThe.js` (hàm thuần), `services/nganHangTeBaoKhangTheKhoiTao.js` (tạo bảng,
chuyển hướng, số liệu trang chủ), `services/nganHangTeBaoKhangTheYeuCau.js` (đường duyệt, các hạn), `services/nganHangTeBaoKhangTheThongBao.js` (email), `db/ngan_hang_te_bao_khang_the_schema.sql`, `public/ngan-hang-te-bao-khang-the/*`.
Test: `tests/nganHangTeBaoKhangThe*.test.js` + `tests/helpers/nganHangServer.js`.

## Để làm gì

Quản lý vị trí từng mẫu sinh học của Viện (dòng tế bào, tế bào gốc, huyết thanh, DNA/RNA, kháng thể, hóa chất / sinh
phẩm): mẫu nằm ở **ô nào của hộp nào, trong giá/ngăn/tủ nào**, ai là người sở hữu, đã lấy ra / rã đông / hủy chưa, và
**lịch sử mọi lần thay đổi**.

```
Vị trí lưu trữ (tủ -80°C, bình nitơ... → ngăn → giá, độ sâu tùy ý)
  └─ Hộp (lưới hàng × cột, tối đa 26 × 30; mẫu hộp 9×9, 10×10, 5×5...)
       └─ Mẫu (ống đông lạnh, kháng thể...) — một ô chứa nhiều nhất một mẫu
```

Tên bảng giữ tiền tố `nhm_` (từ tên cũ «Ngân hàng mẫu») để không mất dữ liệu đã nhập.

## Hai ngân hàng: tế bào và kháng thể

Một module, hai ngân hàng. **Dùng chung:** tài khoản, nhóm nghiên cứu, hồ sơ thành viên, danh sách sinh viên, cấu hình các hạn. **Tách riêng:** thiết bị / hộp / mẫu, yêu cầu, người quản lý, đơn vị quản lý.
- **Màn hình chọn:** vào module (địa chỉ không có `?nh=`) hiện hai nút «Ngân hàng tế bào» / «Ngân hàng kháng thể», mỗi nút ghi số thiết bị, mẫu, việc cần xử lý của người đăng nhập và «Bạn quản lý» nếu có. `GET /banks`.
  Đầu thanh bên luôn ghi ngân hàng đang dùng và có «Đổi ngân hàng». Địa chỉ `index.html?nh=te_bao|khang_the` mở thẳng ngân hàng đó (liên kết trong thư dùng dạng này).
- **Cách tách:** thiết bị gốc mang cột `nhm_containers.ngan_hang` (`te_bao` | `khang_the`), vị trí con / hộp / mẫu theo gốc; dữ liệu có sẵn thuộc ngân hàng tế bào. Giao diện gửi header `X-Ngan-Hang` (hoặc `?nh=`), không gửi thì mặc định tế bào
  (`datNganHang` trong `boiCanh.js`). Dữ liệu của ngân hàng KHÔNG chọn bị ẩn bằng cùng cơ chế với thiết bị riêng (`tapAn`): không ở cây, tìm kiếm, xuất, yêu cầu, số đếm; truy cập theo id (kể cả id trong body: di chuyển, thêm mẫu chéo) là 404.
  **Admin cũng chỉ thấy ngân hàng đang chọn.** Số liệu thẻ trang chủ cộng cả hai.
- **Người quản lý theo ngân hàng:** `nhm_vai_tro.ngan_hang` (`te_bao` | `khang_the` | NULL = cả hai; chỉ vai trò Quản lý có phạm vi). Quản lý kháng thể không thấy và không quản lý được ngân hàng tế bào và ngược lại; quản lý đã có từ trước (không ghi phạm vi) giữ cả hai. Admin cấp ở tab Vai trò (ô «Phạm vi ngân hàng»).
  Thư báo cho quản lý (yêu cầu quá hạn, đã duyệt, đã khai báo, nghi mất…) gửi đúng quản lý của ngân hàng chứa mẫu; tiêu đề thư ghi tên ngân hàng; phiếu in ghi tên ngân hàng.
- **Đơn vị quản lý theo ngân hàng:** `nhm_don_vi.ngan_hang`. Ngân hàng tế bào có **Cellbank**, ngân hàng kháng thể có **Ab-bank** (cả hai có sẵn, không xóa được); thiết bị chỉ gắn được đơn vị cùng ngân hàng. Người duyệt Ab-bank do admin chỉ định; chưa có thì yêu cầu về quản lý kháng thể.
- Bảng vai trò được dựng lại một lần khi khởi động để thêm cột phạm vi (giữ nguyên dữ liệu, id và quyền hiện có).

## Ai làm được gì

Mọi tài khoản đăng nhập (nghiên cứu viên, cán bộ, sinh viên) đều dùng được module: xem sơ đồ, **tìm mẫu**, thêm mẫu vào
thiết bị **công khai**, sửa mẫu của mình. Quản lý chỉ có ở những người **admin** phân quyền.

| Vai trò | Lấy từ đâu | Làm được gì |
|---|---|---|
| **Admin** | `users.role = 'admin'` | Toàn quyền. Là người **duy nhất** cấp / gỡ vai trò module. |
| **Quản lý module** (2–3 người) | bảng `nhm_vai_tro` | Thiết bị lưu trữ, hộp, danh mục, nhóm nghiên cứu, hồ sơ thành viên, sửa / xử lý mọi mẫu, xuất CSV, chuyển chủ sở hữu mẫu. Là người xử lý yêu cầu lấy mẫu: giao mẫu, nhận lại, xử lý thay khi người duyệt vắng. |
| **Viện trưởng** (thiết bị riêng) | bảng `nhm_vai_tro` (`vien_truong`), chỉ admin cấp | Tạo **thiết bị riêng** và toàn quyền với nó (xem «Thiết bị riêng của Viện trưởng»). Không phải quản lý module; việc duyệt yêu cầu ở Cellbank là do được thêm làm người duyệt của đơn vị, tách riêng. |
| **Trưởng CIPP** (quản lý Cellbank) | bảng `nhm_vai_tro` | Là người duyệt của đơn vị **Cellbank** (duyệt yêu cầu lấy mẫu ở thiết bị Cellbank). Không có quyền quản lý kho. |
| Người dùng thường | mọi tài khoản còn lại | Tìm mẫu, thêm mẫu vào thiết bị công khai, sửa / di chuyển / lấy ra / rã đông / hủy / xóa **mẫu của mình**. |
| Sinh viên của Viện (`sinh_vien`) | danh sách chờ do Trung tâm quản lý người học cung cấp | Như người dùng thường, **tới hết hạn dùng** ghi trong danh sách; tài khoản chỉ vào được module này và Đặt lịch thiết bị (xem «Sinh viên của Viện»). |
| Tài khoản `crd_user` | — | Bị chặn khỏi cả module (`authMiddleware`). |

- Vai trò module **không** đụng `users.role` dùng chung toàn hệ thống. **`users.role` = `manager` hay `phong_khcn` không còn tự có
  quyền quản lý** ở module này: phải được admin gán vai trò «Quản lý module».
- Mọi người dùng đọc được toàn bộ kho (kể cả tên người sở hữu): kho là tài nguyên dùng chung của Viện.
- Bảng phân quyền đầy đủ của 86 route nằm trong `tests/nganHangTeBaoKhangThe.phanQuyen.test.js` và được đối chiếu
  với danh sách route thật: thêm/bớt route mà quên cập nhật bảng thì test đỏ.

### Thiết bị Public và thiết bị có đơn vị quản lý

Mỗi **thiết bị gốc** (tủ, bình nitơ) hoặc là **Public**, hoặc gắn với một **đơn vị quản lý** (`nhm_containers.don_vi_id`); ngăn, giá bên trong thừa hưởng.
Chọn ở ô «Ai quản lý thiết bị này» khi **Thêm / Chỉnh sửa thiết bị** (quản lý module và admin). Cột cũ `quan_ly_boi` được giữ cho khớp:
`cong_khai` = Public, `cellbank` = có đơn vị (tên cũ từ lúc chỉ có Cellbank); hai cột luôn đi đôi, API vẫn nhận `quan_ly_boi` kiểu cũ (`cellbank` → đơn vị Cellbank).

| | Public | Có đơn vị quản lý (Cellbank hoặc đơn vị khác) |
|---|---|---|
| Thêm mẫu vào ô trống | ai cũng được | **quản lý module và người duyệt của đơn vị** |
| Sửa thông tin mô tả mẫu | chủ mẫu / quản lý | chủ mẫu / quản lý |
| Di chuyển, lấy ra, rã đông, hủy, xóa mẫu | chủ mẫu / quản lý | **quản lý module và người duyệt của đơn vị** |
| Lấy mẫu của người khác | gửi yêu cầu, **chủ mẫu** duyệt | gửi yêu cầu, **người duyệt của đơn vị** duyệt |

**Người duyệt của đơn vị là cấp quản lý của thiết bị đó** (vd Viện trưởng, Trưởng CIPP với Cellbank): không bị chặn thêm / lấy / di chuyển mẫu ở thiết bị của đơn vị mình (`quanLyDonVi` trong `boiCanh.js`), không phải gửi yêu cầu; ở thiết bị của đơn vị KHÁC thì vẫn như người thường. Họ không có quyền quản lý kho (thêm thiết bị, hộp, danh mục) — quyền đó vẫn là của quản lý module / admin.

**Đơn vị quản lý** (bảng `nhm_don_vi`, `nhm_don_vi_duyet`; `routes/nganHangTeBaoKhangThe/donVi.js`, tab **Quản lý module → Đơn vị quản lý**):
- Có sẵn đơn vị **Cellbank** (không xóa được): người duyệt = những người giữ vai trò **Trưởng CIPP** (+ người được chỉ định thêm).
- **Chỉ admin** tạo / sửa / xóa đơn vị và gán người duyệt (gán người duyệt là trao quyền quyết định, cùng quy tắc cấp vai trò). Quản lý module xem danh sách để chọn đơn vị cho thiết bị.
- Người duyệt phải là tài khoản dùng được module (không bị khóa, không phải tài khoản chỉ Đặt lịch, không phải sinh viên).
- **Nhiều người duyệt** (vd Cellbank: Viện trưởng + Trưởng CIPP): tất cả cùng nhận thư và thấy yêu cầu; **ai xử lý trước thì yêu cầu đóng** (người kia bấm sau nhận 409). Người còn lại nhận thư kết quả và thấy yêu cầu trong «Lịch sử xử lý», không phải làm gì.
- Đơn vị **chưa có người duyệt**: yêu cầu đi thẳng quản lý module. Chỉ xóa được đơn vị khi không còn thiết bị thuộc nó.
- Đổi thiết bị từ đơn vị sang Public (hoặc ngược lại) thì các yêu cầu đang chờ được định tuyến lại.
- Thông báo, lịch sử mẫu và danh sách yêu cầu nêu tên đơn vị (ví dụ «Chờ Cellbank duyệt»); cấp duyệt trong bảng `nhm_yeu_cau.cap` vẫn lưu giá trị cũ `truong_cellbank`.

### Thiết bị riêng của Viện trưởng (Non-public)

Người có vai trò **Viện trưởng** chọn «Riêng tư» ở ô «Ai quản lý thiết bị này» khi thêm thiết bị (`POST /containers` với `rieng: true`; cột `nhm_containers.rieng_user_id`):
- **Chỉ chủ và admin thấy.** Với mọi người khác (kể cả quản lý module, Trưởng CIPP) thiết bị, Rack, hộp, mẫu bên trong **không có**: không ở sơ đồ kho, tìm kiếm, xuất CSV,
  danh sách yêu cầu / phát hiện / sự cố, số đếm «Việc cần xử lý», số liệu thẻ trang chủ; truy cập trực tiếp theo id (đường dẫn hoặc `box_id` / `container_id` / `parent_id` trong body) trả **404 giống hệt id không tồn tại**.
  Cài đặt tập trung ở `boiCanh.js` (`tapAn`, `dkKhongAn`, `chanDuLieuRieng`); mọi truy vấn trả mẫu mới thêm sau này phải dùng `dkKhongAn`. Admin thấy hết (giao diện không nói điều này với người khác).
- **Chủ toàn quyền** ở thiết bị của mình (thêm / sửa / xóa Rack, hộp, mẫu, kiểm kê), không cần là quản lý module. Không có quyền quản lý nơi khác (danh mục, thiết bị của người khác).
- **Đổi chế độ bất cứ lúc nào** (`PATCH /containers/:id` với `rieng: false` và/hoặc `don_vi_id`): thành Public hoặc đơn vị (Cellbank…), hoặc đặt lại riêng. Chỉ đặt «riêng» được với thiết bị **do chính Viện trưởng tạo**; Viện trưởng giữ quyền với thiết bị mình tạo cả khi đã chuyển sang Public / đơn vị.
- Hạn chế đã biết: số mẫu của một **nhóm nghiên cứu** (ở tab Nhóm) vẫn đếm cả mẫu riêng của thành viên nhóm đó. Bảng vai trò cũ được dựng lại một lần khi khởi động để thêm giá trị `vien_truong` (giữ nguyên dữ liệu).

### Bình nitơ lỏng: Rack rồi hộp theo vị trí số

Bình nitơ có nhiều giá, mỗi giá có nhiều hộp. Với thiết bị gốc có loại **Bình nitơ lỏng** (nhận biết theo tên loại, không phân biệt dấu): thêm **Rack** trước và khai
**vị trí Rack trong bình** (`nhm_containers.vi_tri`, 1–50); trong Rack thêm **hộp** và khai **vị trí hộp trong Rack** (`nhm_boxes.vi_tri`, 1–50, số 1 ở trên cùng, càng lớn càng sâu) —
thay cho ô «Số lượng hộp», mỗi lần một hộp. Số không được trùng trong cùng bình (giá) / cùng giá (hộp), API trả 409. Cây kho và danh sách sắp theo vị trí số.
Tủ và thiết bị khác giữ cách cũ (thêm nhiều hộp một lần, không đánh số).

**Mô hình bình xuyên thấu** (`public/ngan-hang-te-bao-khang-the/binh-ln.js`): khi xem bình, giá hoặc hộp nằm trong bình nitơ, cột bên phải (điện thoại: khung gập ở đầu trang)
hiện mặt cắt đứng (giá đứng cạnh nhau, hộp xếp từ trên xuống, số 1 ở trên cùng) và hình nhìn từ trên xuống (các vị trí giá quanh cổ bình, đánh số). **Chấm đỏ** đánh dấu mục đang chọn:
chọn giá → chấm ở giá; chọn hộp → ở ô hộp; rê chuột / chạm một ô ống trên lưới hộp → ngay vị trí ô đó; hình nhìn từ trên chấm đúng vị trí giá. Bấm vào giá / hộp trên mô hình để mở mục đó. Không in ra giấy.

### Loại chủ mẫu và nhóm nghiên cứu

Mỗi mẫu có **loại chủ** (`chu_loai`: sinh viên / nghiên cứu viên / cán bộ) và **nhóm nghiên cứu** (`nhom_id`) — để lọc, tìm
kiếm, và để biết **ai duyệt yêu cầu khi người gửi mẫu đã ra trường / nghỉ việc**. Chỉ quản lý đổi được hai trường này sau khi
mẫu đã tạo (chúng quyết định đường duyệt).

- **Hồ sơ thành viên** (`nhm_ho_so`, do quản lý gán): loại + nhóm + trạng thái (đang hoạt động / **đã rời đi**). Người có hồ sơ
- **Lời chào ở đầu trang** (`nhm_ho_so.chuc_danh`, ≤ 60 ký tự, quản lý đặt ở form hồ sơ): ví dụ «Viện trưởng» thì đầu trang module ghi «Xin chào Viện trưởng»; để trống thì chào bằng tên tài khoản. Chỉ quản lý module / admin đặt được, người dùng không tự đặt.
  thì khi thêm mẫu hệ thống tự lấy loại và nhóm từ hồ sơ; sinh viên chỉ thêm mẫu cho nhóm của mình; hồ sơ «đã rời đi» chặn thêm
  mẫu mới và ghi vào lịch sử mọi mẫu của họ.
- **Người chưa có hồ sơ** vẫn dùng được nhưng phải tự khai loại chủ và nhóm khi thêm mẫu (cán bộ không bắt buộc nhóm; sinh viên
  và nghiên cứu viên bắt buộc).
- **Nhóm nghiên cứu** (`nhm_nhom`): tên + **trưởng nhóm là một tài khoản** (để gửi email duyệt, không gõ tay tên người). Người
  dùng chọn nhóm có sẵn hoặc **đề xuất nhóm mới** (tên + chọn trưởng nhóm qua ô tìm tài khoản). Để tránh nhóm trùng và ghi sai
  trưởng nhóm:
  - tên nhóm so khớp **bỏ dấu, không phân biệt hoa thường**; trùng thì dùng lại nhóm cũ;
  - nhóm mới ở trạng thái **chờ xác nhận**, quản lý kiểm rồi xác nhận, **gộp** được hai nhóm trùng;
  - người được ghi là trưởng nhóm nhận thông báo trong module và phải bấm **«Đúng, tôi là trưởng nhóm»** hoặc **«Không phải»**;
    chưa xác nhận thì coi như chưa có trưởng nhóm (yêu cầu về mẫu của nhóm đó sẽ đi thẳng tới quản lý module — xem «Yêu cầu lấy mẫu»);
  - sinh viên không thể tự ghi mình là trưởng nhóm; sinh viên chỉ thêm mẫu vào nhóm **đã có trưởng nhóm**.
  - Mọi thay đổi nhóm (đổi tên, đổi trưởng nhóm, giải thể, gộp, trưởng nhóm xác nhận / từ chối) ghi vào lịch sử **từng mẫu** của
    nhóm.

## Vòng đời của mẫu

```
in_storage ──checkout──▶ checked_out ──checkin──▶ in_storage
    │                        │
    └──────thaw / discard────┘──▶ thawed ──discard──▶ discarded
```

| Trạng thái | Ô trong hộp | Hiện trên lưới |
|---|---|---|
| `in_storage` Đang lưu kho | giữ | ✔ |
| `checked_out` Đã lấy ra (tạm, chờ trả) | **vẫn giữ** | ✔ viền đỏ |
| `thawed` Đã rã đông | nhả | ✘ (vẫn tìm được bằng «Gồm mẫu đã rã đông / hủy») |
| `discarded` Đã hủy | nhả | ✘ |

- Rã đông / hủy là **điểm cuối**, không hoàn tác. Mẫu đang lấy ra thì không di chuyển được (trả lại trước).
- **Chủ mẫu tự lấy mẫu của mình** (thiết bị công khai) thì không cần ai duyệt, nhưng **bắt buộc khai thông tin thao tác** — lấy ra: mục
  đích sử dụng; trả lại: tình trạng khi trả (còn lại bao nhiêu, có vấn đề gì không); rã đông: mục đích; hủy: lý do. Thiếu hoặc quá ngắn
  (< 3 ký tự) thì 400 và mẫu không đổi trạng thái. Quản lý thao tác hộ cũng phải khai. Thông tin vào lịch sử mẫu và nhật ký hoạt động.
  (Quyền và trạng thái được kiểm trước, nên người lạ vẫn nhận 403.)
- Mẫu của mình ở thiết bị **Cellbank** thì chủ mẫu không tự lấy được mà phải **gửi yêu cầu** như người khác (Trưởng CIPP duyệt); chủ mẫu
  không duyệt được yêu cầu của chính mình. Ở thiết bị công khai thì ngược lại: gửi yêu cầu cho mẫu của mình bị từ chối, hãy «Lấy ra».
- Chủ mẫu thấy mẫu của mình biến mất vì **chính mình đã lấy mà chưa ghi**: bấm **«Chính tôi đã lấy mẫu này»** ở vụ việc nghi mất, ghi
  mục đích (bắt buộc). Mẫu chuyển «đã lấy ra», lịch sử ghi `chu_tu_lay`, vụ việc đóng, **không** tính vào số lần lấy không xin phép.
- **Xóa** (`DELETE /tubes/:id`) là xóa mềm (`deleted_at`) dành cho nhập nhầm; mẫu đã dùng xong thì dùng rã đông / hủy
  để còn dấu vết.
- Chỉ mục duy nhất một phần `ux_nhm_tube_position` bảo đảm một ô một mẫu **ở mức CSDL** (an toàn cả khi hai người
  thao tác cùng lúc), không chỉ kiểm bằng code.

## Lịch sử và nhật ký

- **Lịch sử mẫu** (`nhm_movements`, chỉ thêm không sửa): `store`, `move`, `edit` (ghi **giá trị cũ → mới** dạng JSON
  `{"passage":["P12","P13"]}`; trường không đổi thì không ghi dòng), `checkout`, `checkin`, `thaw`, `discard`,
  `transfer`, `delete`, và `box_move` / `box_edit` khi **hộp** chứa mẫu đổi vị trí lưu trữ / đổi mã (ghi vào từng mẫu
  trong hộp). Bản ghi `edit` cũ chỉ có tên cột (không phải JSON): giao diện vẫn hiển thị được.
- **Không sửa, không xóa được** ở mức CSDL (trigger `trg_nhm_movements_khong_sua / _khong_xoa`), và mỗi dòng lưu **tên người thao tác tại thời điểm đó**
  (`user_label`) nên vẫn đọc được khi tài khoản đổi tên hoặc bị xóa. Ngoài các hành động trên còn có `nhom_doi`, `nhom_giai_the`, `nhom_gop`,
  `nhom_truong_xac_nhan`, `nhom_truong_tu_choi` (nhóm của mẫu đổi) và `chu_roi_di` / `chu_tro_lai` (chủ mẫu rời đi / quay lại).
- Giờ lưu **UTC** (`datetime('now')`), giao diện đổi sang giờ máy người xem.
- **Nhật ký hoạt động** (`user_activity_log`, module `ngan_hang_te_bao_khang_the`): hành động mang tiền tố `nhm_`
  (`nhm_tube_update`, `nhm_box_update`, `nhm_container_delete`, `nhm_tube_export`...), phần chi tiết ghi thay đổi dạng
  «Passage: P12 → P13». Tiền tố cũ `kmsp_` từ bản nháp **chưa từng lên production**.

## Tìm kiếm, xuất, nhập hàng loạt

- `GET /tubes/search`: `q` (tên, đề tài, passage, ghi chú), `sample_type_id`, `owner` (`me` hoặc id), `box_id`,
  `status` (mặc định chỉ mẫu còn trong kho; `all` gồm cả đã rã đông / hủy), `limit` (≤ 200), `offset`.
- `GET /tubes/export.csv` (chỉ quản lý): cùng bộ lọc, tối đa 20.000 dòng, UTF-8 có BOM để Excel đọc đúng tiếng Việt;
  ô bắt đầu bằng `= + - @` được thêm dấu nháy đơn để không bị Excel hiểu là công thức.
- `POST /tubes/bulk`: n ống (1–100) cùng lô vào các ô liên tiếp theo hàng từ ô bắt đầu; **tất cả hoặc không** (một ô
  bị chiếm hoặc vượt lưới thì không thêm mẫu nào).
- Module **không dùng mã vạch** (đã bỏ khỏi giao diện, API và CSV; cột `barcode` ở DB cũ nếu có thì để nguyên, không dùng).
- Route tĩnh (`/tubes/search`, `/tubes/bulk`, `/tubes/export.csv`) đứng **trước** các route `/tubes/:id...` — xem
  «Thứ tự đăng ký route» trong `KIEN-TRUC-VA-CAM-BAY.md`.

## Danh mục

Loại vị trí lưu trữ, mẫu hộp, loại mẫu do **quản lý** thêm / sửa / xóa (nút «Quản lý danh mục»). Quy tắc:
trùng tên 409; loại vị trí lưu trữ và loại mẫu **đang dùng thì không xóa**; xóa mẫu hộp chỉ gỡ liên kết (hộp đã tạo giữ
nguyên kích thước vì `rows/cols` được chụp lại lúc tạo); mẫu hộp đã có hộp dùng thì không đổi kích thước.
Dữ liệu mặc định trong schema chỉ nạp **một lần** (`nhm_meta.seed_v1`) để mục đã xóa không quay lại khi khởi động.

## Kiểm tra đầu vào

Số tế bào, thể tích ≥ 0; nhiệt độ −273…100 °C; ngày đông lạnh đúng `YYYY-MM-DD` và có thật; vị trí nguyên trong lưới;
chuỗi sai trả **400** thay vì bị nuốt thành rỗng. Mã tự sinh (`HOP-0007`, `VC-0003`) bỏ qua mã đã được đặt tay.

## Khởi tạo và địa chỉ cũ

`server.js` chỉ gọi `require('./routes/nganHangTeBaoKhangThe').mount(app, { db, authMiddleware, insertUserActivityLog })`
một lần (cùng số liệu thẻ trang chủ `miniStats`). `mount` tạo bảng (`CREATE ... IF NOT EXISTS`, idempotent; thiếu file
schema thì **ném lỗi** để `server.js` ghi cảnh báo), đăng ký chuyển hướng 302 các địa chỉ cũ về trang mới, và chỉ đổi nhãn
thẻ trang chủ khi dòng `homepage_modules.sample_storage` còn mang **tên cũ** («Ngân hàng mẫu», «Kho mẫu sinh phẩm») —
nhãn admin tự đặt được giữ.

Địa chỉ cũ còn chuyển hướng: `/kho-mau-sinh-pham(.html)`, `/public/kho-mau-sinh-pham/index.html`,
`/ngan-hang-mau(.html)`, `/nganhangmau.html`. Bỏ được khi chắc không còn liên kết nào đã gửi dùng các địa chỉ này
(sửa `LEGACY_PATHS` trong `services/nganHangTeBaoKhangTheKhoiTao.js`).

## Bật / tắt trên trang chủ

Thẻ module (`homepage_modules.code = 'sample_storage'`) hiện **bật sẵn** (`enabled: 1` ở `HOMEPAGE_MODULES_DEFAULT`
trong `server.js`). Tắt chỉ làm mờ thẻ trên trang chủ — **không** chặn trang hay API, giống mọi module khác. Muốn ra
mắt từ từ: đổi mặc định thành `0` rồi để admin bật khi sẵn sàng.

## Sinh viên của Viện (danh sách chờ, xác minh, hết hạn)

Cán bộ có email `@sci.edu.vn` đăng ký tài khoản bình thường (có xác minh hộp thư). Sinh viên **không** có email đó, và đăng ký ở module Đặt lịch
thiết bị **không xác minh hộp thư** (ai gõ email của người khác cũng đăng ký được) nên không thể dùng nó để biết ai là sinh viên của Viện. Cách làm:

1. **Danh sách chờ:** Trung tâm quản lý người học gửi email các đợt sinh viên mới; quản lý module vào **Quản lý module → Sinh viên → Nhập danh sách**:
   - **Tệp Excel (.xlsx) hoặc CSV** — bấm «Tải mẫu Excel» (`GET /students/template.xlsx`: sheet «Danh sách» + sheet «Hướng dẫn»), điền rồi chọn tệp
     (`POST /students/import-file`, trường `tep`, tối đa 2 MB, không nhận .xls cũ). Cột được nhận theo **tên tiêu đề** (không cần đúng thứ tự, thừa cột thì bỏ qua;
     tên cột có `Họ đệm` + `Tên` thì ghép lại); dòng tiêu đề có thể không nằm ở dòng 1 (tìm trong 10 dòng đầu). Hạn là ngày Excel hoặc chữ `dd/mm/yyyy`.
     Tệp của Trung tâm có tiêu đề khác thì thêm tên gọi vào `CAC_COT` trong `services/nganHangTeBaoKhangTheSinhVien.js` (không phải sửa chỗ nào khác).
   - hoặc **dán** (mỗi dòng: email, họ tên, mã sinh viên, khóa / đợt, hạn dùng; dán thẳng từ Excel được).
   - Cả hai đều có bước **Xem trước** (`xem_truoc`): hệ thống đọc, đếm mới / cập nhật / bỏ qua, liệt kê dòng lỗi và vài dòng mẫu **mà chưa ghi gì**; bấm «Nhập» mới ghi.
   - Hạn mặc định áp cho dòng không ghi hạn. Nhập lại nhiều lần không trùng (cập nhật và gia hạn). Bảng `nhm_sinh_vien`.
   - **Thao tác cả đợt** (`POST /students/bulk`, theo cột «Khóa / Đợt»): gia hạn cả đợt, «đợt đã ra trường» (hết hạn từ hôm qua, khóa module ngay), thu hồi cả đợt.
2. Với mỗi email, hệ thống **tạo sẵn** tài khoản vai trò `sinh_vien` **chưa kích hoạt** (mật khẩu rỗng — cách tài khoản tạo sẵn đang dùng).
3. Sinh viên vào trang **Đăng ký chính** (`dang-ky.html`), nhập **đúng email đó** → nhận thư xác minh tới **chính hộp thư** (liên kết dùng một lần, 2 giờ) →
   đặt mật khẩu → tài khoản kích hoạt. Chưa xác minh được hộp thư thì không có tài khoản. Email ngoài `@sci.edu.vn` mà **không** có trong danh sách (hoặc hết
   hạn) nhận **cùng thông báo** nhưng **không có thư** — không ai dò được ai nằm trong danh sách.
4. Lần đầu vào module, tài khoản có **hồ sơ «sinh viên»** (chưa có nhóm): sinh viên chọn nhóm nghiên cứu ở mẫu đầu tiên (hoặc đề xuất nhóm; trưởng nhóm xác nhận),
   nhóm đó được ghi vào hồ sơ; sau đó chỉ thêm mẫu cho nhóm của mình.

**Chặn chiếm email.** Đăng ký CRD bằng email đang nằm trong danh sách bị từ chối (cùng thông báo «email đã được sử dụng»). Tài khoản `crd_user` **cũ** trùng email
với danh sách (đăng ký trước đó, chưa xác minh hộp thư) bị **đặt lại**: vai trò `sinh_vien`, mật khẩu rỗng — chủ email thật xác minh lại là lấy lại được, người
chiếm trước mất quyền. Tài khoản vai trò khác (vd cán bộ) trùng email thì **không đụng tới**.

**Quyền của vai trò `sinh_vien`** (`services/vaiTroHanChe.js`, dùng ở `authMiddleware` và cổng `.html` trong `server.js`): API chỉ `/api/crd/` (Đặt lịch thiết bị) và
`/api/ngan-hang-te-bao-khang-the/`; trang `.html` chỉ Đặt lịch, trang chủ, trang module; mọi thứ khác 403 / chuyển về trang module. Vai trò `crd_user` giữ nguyên
hành vi cũ (chỉ Đặt lịch). Tài khoản dùng chung cho Đặt lịch thiết bị và Ngân hàng — không cần hai tài khoản.

**Hết hạn: chỉ khóa module này.** Hết **ngày** ghi ở cột hạn (giờ Việt Nam), `ctx.chanSinhVien` trả 403 «đã hết hạn» cho mọi API của module (kể cả `/me`), hồ sơ
chuyển «đã rời đi» (yêu cầu về mẫu của họ chuyển cho trưởng nhóm / quản lý, lịch sử ghi `chu_roi_di`). Tài khoản **không bị khóa**: vẫn đặt lịch thiết bị. Bộ quét
30 phút (cùng bộ hẹn giờ với yêu cầu quá hạn) đánh dấu dòng «hết hạn» và xử lý ngay cả khi chưa ai vào. **Gia hạn** (sửa hạn) hoặc nhập lại danh sách thì mở lại và
ghi `chu_tro_lai`; **thu hồi** thì khóa và phải nhập lại để cấp lại. Dòng đã hết hạn / thu hồi **quá 365 ngày bị xóa** khỏi danh sách (dữ liệu cá nhân).

**Dữ liệu cá nhân:** danh sách chỉ có email, họ tên, mã sinh viên, khóa, hạn; chỉ Admin và quản lý module xem; nhật ký hoạt động ghi số lượng chứ **không ghi email**; mỗi
lần xem danh sách có một dòng nhật ký. Email phải khớp đúng email Trung tâm cung cấp (không phân biệt hoa thường); sửa từng dòng ở thẻ «Sinh viên».

## Yêu cầu lấy mẫu

Người dùng bấm **«Xin lấy mẫu này»** ở một mẫu không phải của mình (cần ghi lý do). Mỗi mẫu chỉ có **một** yêu cầu đang xử lý;
mẫu đang nghi mất hoặc không còn lưu kho thì không xin được.

**Ai duyệt** (`services/nganHangTeBaoKhangTheYeuCau.js`, cột `nhm_yeu_cau.cap`):

| Mẫu | Người duyệt | Nếu không có / chính là người xin |
|---|---|---|
| Ở thiết bị **có đơn vị quản lý** (Cellbank hoặc đơn vị khác) | người duyệt của đơn vị | quản lý module |
| Công khai, chủ mẫu là cán bộ / nghiên cứu viên **còn hoạt động** | chủ mẫu | trưởng nhóm → quản lý |
| Công khai, mẫu của **sinh viên** (kể cả đang học), hoặc chủ mẫu đã rời đi | **trưởng nhóm** (đã tự xác nhận, nhóm chưa giải thể) | quản lý |

Sinh viên **không bao giờ** là người duyệt: người sắp ra trường không thể duyệt, nên người ở lại duyệt ngay từ đầu.

- **Quá hạn phản hồi** (mặc định 3 ngày, chỉnh được) người duyệt cấp dưới chưa phản hồi thì yêu cầu **tự chuyển quản lý module** (bộ hẹn giờ 30 phút
  trong tiến trình; câu UPDATE có điều kiện nên chạy chồng không chuyển hai lần; thư báo quản lý; lịch sử ghi không có người thao tác).
- Chủ mẫu / trưởng nhóm vừa **rời đi**, nhóm đổi trưởng nhóm hay trưởng nhóm từ chối: các yêu cầu đang chờ được **định tuyến lại ngay**.
- **Quản lý module và admin luôn xử lý được.** Nếu họ không phải người duyệt của cấp hiện tại thì là **«xử lý thay»**: bắt buộc ghi lý do
  (≥ 5 ký tự), ghi rõ vào lịch sử và nhật ký. Admin là quyền cuối cùng khi không ai xử lý (kể cả ở cấp Trưởng CIPP) nhưng **không**
  hiển thị thành vai trò hay nút riêng. Không ai duyệt được yêu cầu của chính mình, kể cả admin.
- Sau khi **duyệt**, quản lý bấm **«Giao mẫu»** (mẫu chuyển «đã lấy ra») rồi **«Nhận lại mẫu»** khi trả. Mẫu được trả / rã đông / hủy
  / xóa thì yêu cầu liên quan tự đóng.
- **Email** (gửi nền, SMTP hỏng không làm hỏng thao tác chính): yêu cầu mới → người duyệt; đã duyệt → người xin **và** quản lý module;
  **từ chối → người xin và quản lý module** (người vừa xử lý không nhận lại thư); giao / nhận lại → người xin; quá hạn → quản lý. Thư duyệt / từ chối có liên kết tới phiếu in. Liên kết trong thư mở thẳng bảng «Việc cần xử lý» (cần đăng nhập — không có
  liên kết duyệt không cần đăng nhập, vì trình quét thư có thể tự mở liên kết).
- **Lịch sử xử lý** (tab «Lịch sử xử lý» ở «Việc cần xử lý», `GET /requests?view=done`): mọi yêu cầu đã duyệt / từ chối / giao / trả / hủy được lưu vĩnh viễn
  (bảng `nhm_yeu_cau` không xóa). Người duyệt thấy những yêu cầu **mình đã xử lý**; quản lý module và admin thấy tất cả; người xin xem ở «Yêu cầu của tôi».
- **Phiếu yêu cầu in được** (`GET /requests/:id/print`, nút «In phiếu» trên mỗi yêu cầu; `services/nganHangTeBaoKhangThePhieu.js`): trang A4 gồm số phiếu `YC-000123`,
  người yêu cầu, mẫu (vị trí, chủ mẫu, nhóm), mục đích, kết quả. Yêu cầu **đã duyệt** có khung «ĐÃ ĐƯỢC DUYỆT» và đoạn **xác nhận** (đơn vị / người duyệt, giờ duyệt,
  «xử lý thay» nếu có) kèm ba ô ký; **bị từ chối / đã hủy** ghi rõ không dùng để nhận mẫu; **đang chờ** ghi chưa có giá trị nhận mẫu. Người xin bấm «In phiếu / lưu PDF».
  Chỉ người gửi, người đã xử lý, người duyệt ở cấp hiện tại, quản lý module và admin xem được (người khác 403); mỗi lần in ghi nhật ký `request_print`; dữ liệu nhập được escape.
- Mọi bước ghi vào lịch sử của mẫu: `yc_gui`, `yc_duyet`, `yc_tu_choi`, `yc_huy`, `yc_leo_thang`, `yc_dinh_tuyen_lai`, `giao`, `tra`.

## Mẫu có thật trong ô nhưng chưa khai báo (thiết bị công khai)

1. Quản lý bấm vào ô trống → **«Ô này có mẫu nhưng chưa khai báo»**, ghi mô tả (chữ trên ống, màu nắp…) và — nếu đoán được — người / nhóm **có thể** là chủ (chỉ là gợi ý để gửi thư nhắc, không phải kết luận).
   Ô bị **giữ chỗ**: không ai thêm hay di chuyển mẫu khác vào. Thiết bị có đơn vị quản lý (Cellbank…) không dùng chức năng này.
2. **Việc đầu tiên là nhắc chủ mẫu** (`POST /findings/:id/remind`): email người nghi + trưởng nhóm của họ, hoặc trưởng nhóm + mọi thành
   viên đang hoạt động của nhóm nghi; không biết gì thì chỉ hiện trên bảng «Mẫu chưa khai báo» (ai đăng nhập cũng thấy). Nhắc lại được.
3. Chủ mẫu bấm **«Đây là mẫu của tôi»**, điền thông tin ngay tại ô: ô thành mẫu bình thường, chủ mẫu là người nhận, lịch sử mẫu ghi
   `khai_bao_bo_sung`, quản lý nhận thư.
4. Quản lý chỉ được **«Bỏ mẫu»** khi **đã nhắc** và qua **hạn chờ** (mặc định 7 ngày, chỉnh được) kể từ lần nhắc đầu, kèm lý do bắt buộc. Admin bỏ sớm
   hơn được, ghi `da_bo_som`.
5. Mỗi mục có lịch sử riêng (`nhm_phat_hien_ls`, chặn sửa / xóa bằng trigger) vì mẫu chưa có bản ghi để gắn lịch sử.

## Mẫu bị lấy không xin phép (thiết bị công khai)

Phần mềm không ngăn được hành vi ngoài đời; nó giúp **phát hiện**, **cho đường nhận lỗi** và **ghi trách nhiệm**:

- **Phát hiện:** chủ mẫu / trưởng nhóm / quản lý bấm «Báo không còn ở vị trí», hoặc quản lý **kiểm kê hộp** (bấm những mẫu không thấy; mẫu
  còn lại được ghi mốc `thay_luc` = «lần cuối thấy», lịch sử ghi `kiem_ke_thay` / `kiem_ke_khong_thay`).
- Mẫu nghi mất mở một **vụ việc** (`nhm_vu_viec`): chủ mẫu, trưởng nhóm và quản lý nhận thư; mọi người thấy ở bảng «Mẫu nghi mất»;
  mẫu vẫn giữ ô, không xin lấy được.
- Người đã lấy bấm **«Tôi đã lấy mẫu này»** → chủ mẫu (hoặc trưởng nhóm / quản lý) **xác nhận** (mẫu chuyển «đã lấy ra», tính một lần lấy
  không xin phép cho người đó — quản lý xem ở thẻ «Lấy không xin phép») hoặc **từ chối** (vụ việc mở lại). Người nhận không tự xác nhận.
- Tìm thấy mẫu thì đóng vụ việc. Hết **hạn chờ người nhận** (mặc định 14 ngày, chỉnh được) không ai nhận, quản lý **chốt thất lạc** (mẫu thành «đã hủy», đóng
  yêu cầu liên quan); admin chốt sớm được, ghi rõ.
- Mức xử lý người lấy không xin phép là chính sách của Viện — hệ thống chỉ giữ bằng chứng (số lần theo người, có nhóm).

## Cấu hình các hạn

Ba hạn chờ chỉnh được ở **Quản lý module → Cấu hình hạn** (admin và quản lý module; `GET/PUT /settings`, lưu ở bảng `nhm_cau_hinh`,
đọc qua `layHan(db)`):

| Hạn | Mặc định | Khoảng |
|---|---|---|
| Người duyệt cấp dưới phản hồi (quá hạn chuyển quản lý module) | 3 ngày | 1–30 |
| Chờ chủ mẫu khai báo trước khi được bỏ mẫu (tính từ lần nhắc đầu) | 7 ngày | 1–90 |
| Chờ người lấy tự nhận trước khi chốt thất lạc | 14 ngày | 1–90 |

Hạn mới áp dụng cho yêu cầu và vụ việc **tạo sau khi lưu** (yêu cầu / vụ việc đang chạy giữ hạn đã ghi); riêng hạn bỏ mẫu chưa khai
báo được tính lúc xem nên đổi là áp dụng ngay cho mọi mục đang chờ. Mỗi lần đổi ghi nhật ký «cũ → mới». Giá trị hỏng hoặc ngoài
khoảng trong CSDL bị bỏ qua, dùng mặc định. Email và thông báo lỗi luôn nói đúng số ngày đang áp dụng.

## Điện thoại

Giao diện dùng được trên điện thoại: ô tìm và nút «Việc cần xử lý» luôn hiện; sơ đồ kho gập lại sau khi chọn (thanh tóm tắt hiện đường
dẫn); hộp thoại phủ cả màn hình, nút thao tác dính đáy; bảng thành thẻ có nhãn cột; vùng bấm ≥ 44px; ô nhập ≥ 16px để iOS không tự
phóng to; lưới hộp cuộn ngang. Máy cảm ứng không có kéo-thả: di chuyển mẫu đi qua hộp thoại chọn ô.

## Chưa làm

- Nút «Tôi sắp mở tủ X» (ghi dấu ai vào tủ lúc nào, để thu hẹp danh sách người liên quan khi có vụ việc): đã cân nhắc, **chưa bật**
  vì thêm một thao tác cho mọi người dùng.
- Liên kết duyệt một chạm trong email không cần đăng nhập (xem lý do ở mục «Yêu cầu lấy mẫu»).

## Chạy thử cục bộ

`npm test` chạy cả 7 file test của module (DB trong bộ nhớ, không đụng `data/`). Xem giao diện: chạy `node server.js`
với bản sao DB, đăng nhập bằng tài khoản có `users.role` = `admin` để thấy nút quản lý.
