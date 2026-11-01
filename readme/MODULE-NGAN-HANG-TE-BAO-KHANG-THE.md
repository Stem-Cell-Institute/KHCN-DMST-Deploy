# Module Ngân hàng tế bào & Kháng thể

Trang: `public/ngan-hang-te-bao-khang-the/index.html` (địa chỉ ngắn `/ngan-hang-te-bao-khang-the`) ·
API: `/api/ngan-hang-te-bao-khang-the/*` (46 route)

Mã nguồn: `routes/nganHangTeBaoKhangThe/` (`index.js`, `boiCanh.js`, `khoLuuTru.js`, `danhMuc.js`, `thanhVien.js`,
`timKiem.js`, `mau.js`), `services/nganHangTeBaoKhangThe.js` (hàm thuần), `services/nganHangTeBaoKhangTheKhoiTao.js` (tạo bảng,
chuyển hướng, số liệu trang chủ), `db/ngan_hang_te_bao_khang_the_schema.sql`, `public/ngan-hang-te-bao-khang-the/*`.
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

## Ai làm được gì

Mọi tài khoản đăng nhập (nghiên cứu viên, cán bộ, sinh viên) đều dùng được module: xem sơ đồ, **tìm mẫu**, thêm mẫu vào
thiết bị **công khai**, sửa mẫu của mình. Quản lý chỉ có ở những người **admin** phân quyền.

| Vai trò | Lấy từ đâu | Làm được gì |
|---|---|---|
| **Admin** | `users.role = 'admin'` | Toàn quyền. Là người **duy nhất** cấp / gỡ vai trò module. |
| **Quản lý module** (2–3 người) | bảng `nhm_vai_tro` | Thiết bị lưu trữ, hộp, danh mục, nhóm nghiên cứu, hồ sơ thành viên, sửa / xử lý mọi mẫu, xuất CSV, chuyển chủ sở hữu mẫu. Là người xử lý yêu cầu lấy mẫu (đợt sau). |
| **Trưởng CIPP** (quản lý Cellbank) | bảng `nhm_vai_tro` | Duyệt yêu cầu lấy mẫu ở thiết bị **Cellbank** (đợt sau). Không có quyền quản lý kho. |
| Người dùng thường | mọi tài khoản còn lại | Tìm mẫu, thêm mẫu vào thiết bị công khai, sửa / di chuyển / lấy ra / rã đông / hủy / xóa **mẫu của mình**. |
| Tài khoản `crd_user` | — | Bị chặn khỏi cả module (`authMiddleware`). |

- Vai trò module **không** đụng `users.role` dùng chung toàn hệ thống. **`users.role` = `manager` hay `phong_khcn` không còn tự có
  quyền quản lý** ở module này: phải được admin gán vai trò «Quản lý module».
- Mọi người dùng đọc được toàn bộ kho (kể cả tên người sở hữu): kho là tài nguyên dùng chung của Viện.
- Bảng phân quyền đầy đủ của 46 route nằm trong `tests/nganHangTeBaoKhangThe.phanQuyen.test.js` và được đối chiếu
  với danh sách route thật: thêm/bớt route mà quên cập nhật bảng thì test đỏ.

### Hai loại thiết bị lưu trữ

Mỗi **thiết bị gốc** (tủ, bình nitơ) mang một kiểu quản lý (`nhm_containers.quan_ly_boi`); ngăn, giá bên trong thừa hưởng:

| | Công khai (`cong_khai`, mặc định) | Cellbank (`cellbank`) |
|---|---|---|
| Thêm mẫu vào ô trống | ai cũng được | **chỉ quản lý module** |
| Sửa thông tin mô tả mẫu | chủ mẫu / quản lý | chủ mẫu / quản lý |
| Di chuyển, lấy ra, rã đông, hủy, xóa mẫu | chủ mẫu / quản lý | **chỉ quản lý module** |
| Lấy mẫu của người khác | gửi yêu cầu, **chủ mẫu** duyệt (đợt sau) | gửi yêu cầu, **Trưởng CIPP** duyệt (đợt sau) |

### Loại chủ mẫu và nhóm nghiên cứu

Mỗi mẫu có **loại chủ** (`chu_loai`: sinh viên / nghiên cứu viên / cán bộ) và **nhóm nghiên cứu** (`nhom_id`) — để lọc, tìm
kiếm, và để biết **ai duyệt yêu cầu khi người gửi mẫu đã ra trường / nghỉ việc**. Chỉ quản lý đổi được hai trường này sau khi
mẫu đã tạo (chúng quyết định đường duyệt).

- **Hồ sơ thành viên** (`nhm_ho_so`, do quản lý gán): loại + nhóm + trạng thái (đang hoạt động / **đã rời đi**). Người có hồ sơ
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
    chưa xác nhận thì coi như chưa có trưởng nhóm (yêu cầu về mẫu của nhóm đó sẽ đi thẳng tới quản lý module);
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

## Chưa làm (đã thống nhất thiết kế, làm ở đợt sau)

1. **Yêu cầu lấy mẫu** (gửi → duyệt → giao → trả) kèm email thông báo cho người yêu cầu và quản lý module:
   - thiết bị Cellbank: Trưởng CIPP duyệt; thiết bị công khai: chủ mẫu duyệt;
   - nếu chủ mẫu (hoặc sinh viên) đã rời đi: **trưởng nhóm duyệt trước**, nhóm không còn trưởng nhóm / trưởng nhóm chưa xác nhận /
     quá hạn phản hồi thì **chuyển quản lý module**; quản lý luôn có nút «Xử lý thay» kèm lý do bắt buộc, ghi vào lịch sử;
   - admin có thể xử lý mọi yêu cầu (quyền cuối cùng khi không ai xử lý), không hiển thị thành vai trò hay nút riêng;
   - mọi bước ghi vào lịch sử mẫu.
2. **Mẫu có thật trong ô nhưng chưa khai báo** (ở thiết bị công khai): quản lý đánh dấu ô «phát hiện mẫu chưa khai báo» (mô tả,
   người / nhóm nghi là chủ), hệ thống **nhắc chủ mẫu trước** (email, bảng «mẫu chưa khai báo»), chủ mẫu nhận và điền thông tin
   ngay tại ô; quản lý chỉ được **bỏ mẫu** sau khi đã nhắc và hết thời hạn chờ (đề xuất 7 ngày); admin bỏ sớm hơn thì ghi rõ.
3. **Mẫu bị lấy mà không xin phép** (thiết bị công khai): chủ mẫu bấm «mẫu của tôi không còn ở đây» hoặc quản lý **kiểm kê hộp**
   (đối chiếu sổ với thực tế, lưu mốc «lần cuối thấy mẫu»); mẫu nghi mất mở vụ việc, người dùng khác có thể nhận «tôi đã lấy»
   (chủ mẫu xác nhận thành yêu cầu bổ sung), hết hạn không ai nhận thì quản lý chốt «thất lạc»; quản lý xem số lần vi phạm theo người.
4. **Rà toàn bộ giao diện cho điện thoại** (thiết bị cầm tay, duyệt yêu cầu một chạm từ email).

## Chạy thử cục bộ

`npm test` chạy cả 7 file test của module (DB trong bộ nhớ, không đụng `data/`). Xem giao diện: chạy `node server.js`
với bản sao DB, đăng nhập bằng tài khoản có `users.role` = `admin` để thấy nút quản lý.
