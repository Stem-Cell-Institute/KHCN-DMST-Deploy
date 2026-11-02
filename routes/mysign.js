/**
 * API hạ tầng ký số MySign — gắn tại /api/mysign (sau authMiddleware). Dùng chung cho mọi module có ký số.
 *
 *   GET    /tai-khoan        tài khoản MySign đã liên kết của người đang đăng nhập + hệ thống đã cấu hình MySign chưa
 *   PUT    /tai-khoan        { mysign_user_id } liên kết / đổi tài khoản. MySign xác nhận tài khoản có chứng thư số thì mới lưu.
 *   DELETE /tai-khoan        bỏ liên kết (không được khi đang có yêu cầu ký chờ xác nhận)
 *   GET    /giao-dich/:id    trạng thái một yêu cầu ký của chính mình; hỏi MySign và hoàn tất nếu đã có kết quả
 *
 * Không có mật khẩu MySign nào đi qua đây: người dùng chỉ khai mã tài khoản, còn mỗi lần ký thì xác nhận trên điện thoại.
 */

const express = require('express');
const { kySoChung } = require('../services/mysign');
const { LoiMySign } = require('../services/mysign/client');

const MA_TAI_KHOAN = /^[A-Za-z0-9_.@-]{1,50}$/;

/** @param {{db:object, uploadsRoot?:string, kySo?:object}} deps  kySo: chỉ test truyền vào (MySign giả lập) */
module.exports = function createMySignRouter({ db, uploadsRoot, kySo }) {
  const router = express.Router();
  const ks = kySo || kySoChung({ db, uploadsRoot });

  const loi = (res, status, message) => res.status(status).json({ message });
  const bao = (fn) => (req, res) =>
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((e) => {
        if (e instanceof LoiMySign) return loi(res, e.ma === 'chua_lien_ket' ? 409 : 400, e.nguoiDung);
        console.error('[mysign]', req.method, req.originalUrl, e);
        if (!res.headersSent) loi(res, 500, 'Có lỗi hệ thống. Vui lòng thử lại.');
      });

  router.use((req, res, next) => (req.user && req.user.id ? next() : loi(res, 401, 'Chưa đăng nhập')));

  const hienTaiKhoan = (tk) =>
    tk && { mysign_user_id: tk.mysign_user_id, chu_the: tk.chu_the, het_han: tk.het_han, so_dien_thoai: anSo(tk.so_dien_thoai), cap_nhat_luc: tk.cap_nhat_luc };
  const anSo = (s) => (s ? String(s).replace(/^(.*)(\d{3})$/, (m, a, b) => '*'.repeat(Math.max(0, a.length)) + b) : null);

  router.get(
    '/tai-khoan',
    bao((req, res) => res.json({ da_cau_hinh: ks.mysign.daCauHinh(), tai_khoan: hienTaiKhoan(ks.taiKhoan(req.user.id)) }))
  );

  router.put(
    '/tai-khoan',
    bao(async (req, res) => {
      const ma = typeof (req.body && req.body.mysign_user_id) === 'string' ? req.body.mysign_user_id.trim() : '';
      if (!MA_TAI_KHOAN.test(ma)) return loi(res, 400, 'Mã tài khoản MySign không hợp lệ (tối đa 50 ký tự, không dấu cách).');
      if (ks.dangChoCuaNguoi(req.user.id)) return loi(res, 409, 'Đang có yêu cầu ký chờ xác nhận. Hãy xác nhận hoặc từ chối trên MySign trước.');
      const tk = await ks.lienKet(req.user.id, ma);
      res.json({ ok: true, tai_khoan: hienTaiKhoan(tk) });
    })
  );

  router.delete(
    '/tai-khoan',
    bao((req, res) => {
      ks.huyLienKet(req.user.id);
      res.json({ ok: true });
    })
  );

  router.get(
    '/giao-dich/:id',
    bao(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return loi(res, 400, 'ID không hợp lệ.');
      const g = ks.giaoDich(id);
      if (!g || g.user_id !== req.user.id) return loi(res, 404, 'Không tìm thấy yêu cầu ký.');
      res.json(await ks.capNhat(id));
    })
  );

  return router;
};
