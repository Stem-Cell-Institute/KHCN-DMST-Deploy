/**
 * API hạ tầng ký số MySign — gắn tại /api/mysign (sau authMiddleware). Dùng chung cho mọi module có ký số.
 *
 *   GET    /tai-khoan        tài khoản MySign đã liên kết của người đang đăng nhập + hệ thống đã cấu hình MySign chưa
 *   PUT    /tai-khoan        { mysign_user_id } liên kết / đổi tài khoản. MySign xác nhận tài khoản có chứng thư số thì mới lưu.
 *   DELETE /tai-khoan        bỏ liên kết (không được khi đang có yêu cầu ký chờ xác nhận)
 *   GET    /giao-dich/:id    trạng thái một yêu cầu ký của chính mình; hỏi MySign và hoàn tất nếu đã có kết quả
 *
 * TRANG THỬ (chỉ quản trị viên; trang ky-so-thu.html): ký một PDF MẪU bằng tài khoản MySign của chính mình để thử chữ ký số mà không cần
 * vai trò Viện trưởng hay dữ liệu nghiệp vụ.
 *   GET    /thu/xem-truoc            PDF mẫu chưa có khung + thông tin trang (header X-Ky-So-Meta) để kéo khung
 *   POST   /thu/ky                   { vi_tri? } gửi yêu cầu ký PDF mẫu; theo dõi qua GET /giao-dich/:id
 *   GET    /thu/ban-ky/:id           tải PDF mẫu đã ký (?xem=1 mở trong trình duyệt)
 *   GET    /thu/kiem-tra/:id         kiểm chữ ký trong PDF đã ký: hợp lệ không, chứng thư của ai
 *
 * Không có mật khẩu MySign nào đi qua đây: người dùng chỉ khai mã tài khoản, còn mỗi lần ký thì xác nhận trên điện thoại.
 */

const express = require('express');
const { kySoChung } = require('../services/mysign');
const { LoiMySign } = require('../services/mysign/client');
const Pades = require('../services/mysign/pades');
const { taoPdfThu } = require('../services/mysign/pdfThu');
const { kiemViTri } = require('../services/mysign/viTri');

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

  // ── Trang thử ký số (PDF mẫu) ──────────────────────────────────────────────
  const NGUON_THU = 'thu_nghiem';
  ks.dangKyNguon(NGUON_THU, { khiThanhCong: () => [] }); // không có nghiệp vụ đi kèm: ký xong là xong
  const chiAdmin = (req, res, next) => (String(req.user.role || '').toLowerCase() === 'admin' ? next() : loi(res, 403, 'Trang thử ký số chỉ dành cho quản trị viên.'));
  const tenNguoiKy = (req) => (db.prepare('SELECT fullname FROM users WHERE id = ?').get(req.user.id) || {}).fullname || req.user.fullname || req.user.email || '';
  const asciiJson = (o) => JSON.stringify(o).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

  router.get(
    '/thu/xem-truoc',
    chiAdmin,
    bao(async (req, res) => {
      const kq = await taoPdfThu({ ten: tenNguoiKy(req), xemTruoc: true });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('X-Ky-So-Meta', asciiJson({ ...kq.meta, gan_nhat: ks.viTriGanNhat(req.user.id, NGUON_THU) }));
      res.setHeader('Content-Length', kq.pdf.length);
      res.setHeader('Cache-Control', 'no-store');
      res.end(kq.pdf);
    })
  );

  router.post(
    '/thu/ky',
    chiAdmin,
    bao(async (req, res) => {
      let viTri;
      if (req.body && req.body.vi_tri !== undefined) {
        const kq = kiemViTri(req.body.vi_tri);
        if (kq.loi) return loi(res, 400, kq.loi);
        viTri = kq.vi_tri;
      }
      const ten = tenNguoiKy(req);
      try {
        const g = await ks.batDau({
          userId: req.user.id,
          nguon: NGUON_THU,
          moTa: 'Thu ky so MySign',
          taiLieu: [{ nguonId: req.user.id, ten: 'Tai lieu thu ky so', meta: {}, taoPdfCho: () => taoPdfThu({ ten, viTri }).then((r) => r.pdf) }],
        });
        if (viTri) ks.luuViTri(req.user.id, NGUON_THU, { ...viTri, trang_cuoi: viTri.trang === 2 });
        res.json({ ok: true, giao_dich: g });
      } catch (e) {
        if (e && e.maLoi === 'vi_tri') return loi(res, 400, e.message);
        throw e;
      }
    })
  );

  /** Tệp đã ký của một giao dịch thử của CHÍNH người gọi. */
  function banKyThu(req) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    const g = ks.giaoDich(id);
    if (!g || g.user_id !== req.user.id || g.nguon !== NGUON_THU) return null;
    const t = db.prepare("SELECT tep_da_ky FROM mysign_tai_lieu WHERE giao_dich_id = ? AND trang_thai = 'da_ky' ORDER BY id DESC LIMIT 1").get(id);
    return t && t.tep_da_ky ? ks.docTep(t.tep_da_ky) : null;
  }

  router.get(
    '/thu/ban-ky/:id',
    chiAdmin,
    bao((req, res) => {
      const pdf = banKyThu(req);
      if (!pdf) return loi(res, 404, 'Chưa có bản đã ký cho yêu cầu này.');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', (req.query.xem === '1' ? 'inline' : 'attachment') + '; filename="thu-ky-so-mysign.pdf"');
      res.setHeader('Content-Length', pdf.length);
      res.setHeader('Cache-Control', 'no-store');
      res.end(pdf);
    })
  );

  router.get(
    '/thu/kiem-tra/:id',
    chiAdmin,
    bao((req, res) => {
      const pdf = banKyThu(req);
      if (!pdf) return loi(res, 404, 'Chưa có bản đã ký cho yêu cầu này.');
      res.json(Pades.kiemTra(pdf));
    })
  );

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
