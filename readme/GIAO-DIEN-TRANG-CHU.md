# Trang chủ — hợp đồng hướng thiết kế

Bản ghi quyết định thị giác cho `index.html`. Đọc trước khi sửa giao diện trang chủ.

Mode: **Persuade ở khối mở đầu** (đây là cửa trước công khai tại `eoffice.sci.edu.vn`),
**Operate ở phần thân** (danh mục module cho cán bộ vào việc).

## Direction contract

**THESIS** — Trang chủ là **trang nhất của một công báo khoa học**, không phải dashboard SaaS.
Nó từ chối đúng cái cấu trúc đang có: lưới thẻ cùng cỡ gồm icon–tiêu đề–mô tả làm khung xương
toàn trang, và mẫu "số to – nhãn nhỏ – thống kê phụ". Thông tin xếp theo trật tự văn bản hành
chính: măng-sét, đường kẻ, mục đánh số, khối ký.

**OWN-WORLD** — Vật liệu lấy từ văn bản hành chính Việt Nam, bản bão hoà chứ không phải bản
giấy kem nhạt: **mực xanh đen** `#16233D` chiếm trọn vùng măng-sét, **son dấu đỏ** `#B7281E`
làm màu tín hiệu duy nhất (chấm trực tiếp, mốc mục, cảnh báo), giấy trắng hơi lạnh `#FAFAF8`
cho vùng đọc. Không gradient. Không bóng mờ. Phân cách bằng **đường kẻ 1px** và khoảng trắng,
không bằng thẻ nổi. Chữ số dùng `tabular-nums`. Một bộ chữ duy nhất — **Be Vietnam Pro**, thiết
kế cho tiếng Việt chứ không phải serif phương Tây đeo dấu — sức nặng do cân nặng và cỡ chữ tạo
ra. Nhận ra được cả khi xoá hết nội dung: trường xanh đen đặc + kẻ ngang + số liệu thẳng cột.

**STORY** — Khách thấy ngay đây là cơ quan khoa học công lập thật, có số liệu thật, không phải
một sản phẩm phần mềm. Cán bộ quét một lượt là tới đúng module của mình.

**FIRST VIEWPORT** — Măng-sét: trường mực xanh đen chiếm hết chiều ngang, logo Viện bên trái,
tên hệ thống đặt theo trục trái (không căn giữa), dòng định danh đơn vị bên dưới, nút Đăng nhập
neo phải cùng hàng. Dưới măng-sét là một đường kẻ son đỏ 2px. Kế đó: dải thông báo chạy. Rồi
**bảng số liệu một hàng** — năm chỉ số xếp thẳng cột, phân cách bằng kẻ dọc, không thẻ, không
icon. Hành động chính (Đăng nhập) nằm ở măng-sét.

**FORM** — Công báo/văn bản hành chính. Đứng đầu danh sách vì nó là thể loại thật của chính hệ
thống này, không phải phép ẩn dụ mượn. SEED REFERENCE: `seed: none (unavailable)`

**FINISH** — unreviewed and undocumented is unfinished; this build ends with the finish review,
the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Vì sao không chọn "giấy kem + serif + cam đất"

`new-work.md` của skill liệt kê thẳng cụm đó là một trong các diện mạo mà mô hình sinh ra bất kể
chủ đề, và yêu cầu: *nếu đoán được thẩm mỹ chỉ từ thể loại thì phải làm lại*. "Công báo" mà ra
giấy kem + serif tương phản cao + cam đất là đúng cụm đó. Thế giới được ghim giữ nguyên, nhưng
dựng từ dải vật liệu bão hoà của nó: son dấu, mực xanh đen, bìa hồ sơ.

Cùng lý do, không dùng `Lora`, `Playfair Display`, `Crimson`, `Newsreader`, `IBM Plex` — skill
xếp chúng vào "training-data defaults".

## Ràng buộc kỹ thuật

- **Tiếng Việt cần font phủ đủ dấu.** Be Vietnam Pro phủ gốc. Hiện nạp qua Google Fonts; nên
  self-host để không phụ thuộc mạng ngoài — xem Nợ kỹ thuật.
- Icon là 19 `<svg>` thật, giữ nguyên. Đổi `stroke="#ffffff"` thành `currentColor` để icon ăn
  theo màu chữ thay vì cứng màu trắng.
- Giữ nguyên toàn bộ nội dung, đường dẫn, `id`/`data-*` mà JS đang bám vào.
