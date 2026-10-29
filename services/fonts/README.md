# Font dùng để xuất PDF

`Tinos-*.ttf` (Regular, Bold, Italic, BoldItalic) — font tương thích số đo với Times New Roman,
có đủ dấu tiếng Việt. Dùng cho `services/baoCaoPhongXuat.js` khi dựng PDF.

- Nguồn: https://github.com/google/fonts/tree/main/ofl/tinos
- Giấy phép: SIL Open Font License 1.1 (xem `OFL.txt`) — cho phép đóng gói kèm phần mềm
- Bản quyền: The Tinos Project Authors

**Vì sao phải đóng gói font vào repo:** image Docker `node:24-bookworm-slim` không có font nào, và PDF
phải *nhúng* font mới hiển thị đúng tiếng Việt trên máy người đọc. Font mặc định của PDF (Times,
Helvetica) KHÔNG có dấu tiếng Việt: chữ sẽ vỡ thành ký tự lạ.

Thư mục này nằm dưới `services/` nên bị chặn tải qua web (`server.js` — danh sách chặn).
