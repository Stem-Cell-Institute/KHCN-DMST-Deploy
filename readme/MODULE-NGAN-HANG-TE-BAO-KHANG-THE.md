# Module Ngân hàng tế bào & Kháng thể

Trang: `public/ngan-hang-te-bao-khang-the/index.html` (địa chỉ ngắn `/ngan-hang-te-bao-khang-the`) ·
API: `/api/ngan-hang-te-bao-khang-the/*` (32 route)

Mã nguồn: `routes/nganHangTeBaoKhangThe/` (`index.js`, `boiCanh.js`, `khoLuuTru.js`, `danhMuc.js`, `timKiem.js`,
`mau.js`), `services/nganHangTeBaoKhangThe.js` (hàm thuần), `services/nganHangTeBaoKhangTheKhoiTao.js` (tạo bảng,
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

| | Xem sơ đồ, hộp, mẫu, lịch sử, **tìm mẫu** | **Thêm** mẫu (đơn lẻ / cùng lô) | Sửa, di chuyển, lấy ra / trả lại, rã đông, hủy, xóa **mẫu** | Vị trí lưu trữ, hộp, danh mục, xuất CSV, chuyển chủ |
|---|---|---|---|---|
| Mọi người đã đăng nhập | ✔ | ✔ (vào bất kỳ ô trống) | chỉ mẫu **của mình** | ✘ |
| Admin / Manager / Phòng KHCN (`users.role`) | ✔ | ✔ | ✔ mọi mẫu | ✔ |
| Tài khoản `crd_user` | ✘ (chặn ở `authMiddleware`) | ✘ | ✘ | ✘ |

- **Chủ ý:** mẫu **không** đòi quyền quản lý để thêm/sửa — nhà nghiên cứu tự khai và tự giữ mẫu của mình; người
  sở hữu = người tạo. Quản lý sửa được mọi mẫu và **chuyển chủ sở hữu** (`POST /tubes/:id/transfer`) khi người sở hữu
  nghỉ việc / bàn giao đề tài. Chủ cũ mất quyền ngay.
- `MANAGE_ROLES` chỉ xét cột `users.role` (`admin`, `manager`, `phong_khcn`). Quyền `phong_khcn` được cấp **thêm**
  qua `council_role_grants` **không** tính ở đây.
- Mọi người dùng đọc được toàn bộ kho (kể cả tên người sở hữu): kho là tài nguyên dùng chung của Viện. Nếu sau này cần
  giấu mẫu theo đề tài thì đây là chỗ phải thêm lọc đọc — hiện **chưa có**.
- Bảng phân quyền đầy đủ của 32 route nằm trong `tests/nganHangTeBaoKhangThe.phanQuyen.test.js` và được đối chiếu
  với danh sách route thật: thêm/bớt route mà quên cập nhật bảng thì test đỏ.

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

## Chạy thử cục bộ

`npm test` chạy cả 7 file test của module (DB trong bộ nhớ, không đụng `data/`). Xem giao diện: chạy `node server.js`
với bản sao DB, đăng nhập bằng tài khoản có `users.role` = `admin` để thấy nút quản lý.
