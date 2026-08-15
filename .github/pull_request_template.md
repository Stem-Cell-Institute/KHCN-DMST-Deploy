<!--
  Mẫu PR cho repo KHCN-DMST (STIMS / SCI-ACE).
  Hệ thống đang chạy thật tại eoffice.sci.edu.vn — mọi PR đều giả định là sẽ lên production.

  PR refactor: tick đủ mục "Nếu đây là một đợt tách server.js".
  PR thường (sửa lỗi, thêm tính năng): xóa hẳn mục đó đi.
-->

## Việc gì

<!-- 1–3 câu. Đợt mấy / sửa lỗi gì / thêm gì. -->

-

## Nếu đây là một đợt tách `server.js`

Theo §4 của [readme/KE-HOACH-REFACTOR.md](../readme/KE-HOACH-REFACTOR.md):

- [ ] `diff` route-inventory trước/sau **rỗng**

  ```bash
  node scripts/route-inventory.js > routes-after.txt
  diff routes-before.txt routes-after.txt
  ```

- [ ] `npm test` xanh, **có test mới** cho nhóm vừa tách
- [ ] `server.js` giảm đúng số dòng đã chuyển đi (không phát sinh code mới)
- [ ] **Không sửa logic nghiệp vụ** trong cùng commit — chỉ cắt–dán và đổi import
- [ ] Đã bấm thử tay ≥ 3 màn hình frontend liên quan
- [ ] Đã hạ số trong `.github/server-js-max-lines` xuống bằng số dòng mới

## Kiểm thử

- [ ] `npm test` xanh (chạy tay — CI chưa chạy được test, xem nợ kỹ thuật #7)
- [ ] Đã thử trên trình duyệt

Màn hình / endpoint đã thử:

-

## Rủi ro & cách quay lui

<!-- Hỏng thì quay lui bằng gì? Với PR refactor: `git revert -m 1 <merge-commit>`. -->

-

## Ghi chú

<!-- Nợ kỹ thuật phát sinh (ghi vào readme/REFACTOR-PROGRESS.md), việc cố ý bỏ qua, v.v. -->

-
