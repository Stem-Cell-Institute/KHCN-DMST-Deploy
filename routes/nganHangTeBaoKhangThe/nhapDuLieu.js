'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — NHẬP / XUẤT DỮ LIỆU ngay trên giao diện (Quản lý module → Nhập dữ liệu). 3 endpoint.
 *
 * POST /import/cellseeker  (Admin; multipart: tep = .zip xuất từ Cellseeker; kieu_dem = hang | cot; ghi = 1)
 * POST /import/excel       (Admin; multipart: tep = .xlsx do «Xuất Excel» tạo ra; ghi = 1)
 * GET  /containers/:id/export.xlsx  (quản lý module; xuất một thiết bị gốc ra Excel, nhập lại được bằng /import/excel)
 *
 *   Không có `ghi` = chỉ KIỂM TRA: làm mọi bước trong một giao dịch rồi hủy nên số liệu đúng như khi ghi thật, nhưng không đổi gì. Ghi thật là một giao dịch duy nhất
 *   (lỗi thì không có gì được ghi) và chỉ THÊM dữ liệu: không sửa, không xóa; nhập lại không tạo trùng. Trước khi ghi có sao lưu CSDL (nếu làm được).
 *   Tệp .zip được giải nén vào thư mục tạm (chỉ lấy *.csv và stock-attachments/, tên tệp lấy phần cuối, chặn zip nén quá mức) rồi xóa ngay.
 * Logic: services/nganHangTeBaoKhangTheNhapCellseeker.js (ghi CSDL dùng chung) và nganHangTeBaoKhangTheExcel.js (đọc / viết Excel).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const appPaths = require('../../lib/appPaths');
const Nhap = require('../../services/nganHangTeBaoKhangTheNhapCellseeker');
const Excel = require('../../services/nganHangTeBaoKhangTheExcel');
const { toInt } = require('../../services/nganHangTeBaoKhangThe');

const TOI_DA_TEP = 80 * 1048576;

module.exports = function createNhapDuLieuRouter(ctx, deps = {}) {
  const { db, requireAdmin, requireManage, audit, fail } = ctx;
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: TOI_DA_TEP, files: 1, fields: 6, parts: 8 } });
  let dangChay = false; // đồng bộ cả hai bước kiểm tra / ghi: mỗi lúc chỉ một lần nhập

  /** Sao lưu CSDL trước khi ghi (best effort). Trả tên tệp hoặc null. */
  async function saoLuu() {
    try {
      if (!db.name || db.name === ':memory:' || !fs.existsSync(db.name)) return null;
      const thuMuc = path.join(path.dirname(db.name), 'backups');
      fs.mkdirSync(thuMuc, { recursive: true });
      const ten = `truoc-nhap-du-lieu-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.db`;
      await db.backup(path.join(thuMuc, ten));
      return ten;
    } catch (e) {
      console.warn('[ngan-hang] sao lưu trước khi nhập dữ liệu lỗi:', e && e.message);
      return null;
    }
  }

  const nhanNhap = (req, res, next) => {
    if (req.nganHang !== 'te_bao') return fail(res, 400, 'Nhập dữ liệu chỉ dùng ở ngân hàng tế bào.');
    upload.single('tep')(req, res, (e) => {
      if (e) return fail(res, 400, e.code === 'LIMIT_FILE_SIZE' ? `Tệp quá lớn (tối đa ${TOI_DA_TEP / 1048576} MB).` : 'Không nhận được tệp: ' + e.message);
      next();
    });
  };

  /** Kiểm tra / ghi dùng chung. `lapKeHoach(buffer)` → {ke, don?} (don dọn thư mục tạm); `nhan` dùng cho nhật ký. */
  async function xuLy(req, res, nhan, lapKeHoach) {
    if (!req.file) return fail(res, 400, 'Chưa chọn tệp.');
    const ghi = (req.body || {}).ghi === '1' || (req.body || {}).ghi === 'true';
    if (dangChay) return fail(res, 409, 'Đang có một lần nhập khác chạy. Đợi xong rồi thử lại.');
    dangChay = true;
    let don = null;
    try {
      const lap = await lapKeHoach(req.file.buffer);
      don = lap.don || null;
      const ke = lap.ke;
      const sao = ghi ? await saoLuu() : null;
      const kq = Nhap.thucThi(db, ke, { nguoiId: req.user.id, ghi, uploadsRoot: deps.uploadsRoot || appPaths.uploadsRoot() });
      const dem = {
        thiet_bi: ke.thietBi.length, rack: ke.thietBi.reduce((n, x) => n + x.rack.length, 0), hop: ke.thietBi.reduce((n, x) => n + x.rack.reduce((m, r) => m + r.hop.length, 0), 0),
        dong: ke.dong.length, lo: ke.lo.length, ong: ke.ong.length, qc: (ke.qc || []).length, tep: ke.tepLo.length,
      };
      if (ghi) audit(req, 'import_' + nhan, `${req.file.originalname}: mới ${kq.dong.moi} dòng, ${kq.lo.moi} lô, ${kq.ong.moi} ống, ${kq.hop.moi} hộp, ${kq.qc.moi} QC, ${kq.tep.moi} tệp (bỏ qua ${kq.ong.boQua} ống)`);
      res.json({ da_ghi: ghi, kieu_dem: ke.kieuDem, trong_tep: dem, ket_qua: kq, vi_du: ke.viDu, sao_luu: sao });
    } catch (e) {
      if (e && e.code && String(e.code).startsWith('SQLITE')) {
        console.error('[ngan-hang] nhập dữ liệu lỗi CSDL:', e.message);
        return fail(res, 500, 'Lỗi cơ sở dữ liệu khi nhập: không có gì được ghi (giao dịch đã hủy).');
      }
      return fail(res, (e && e.status) || 400, e && e.message ? e.message : 'Không nhập được.'); // lỗi do dữ liệu / tệp: thông báo tiếng Việt của dịch vụ nhập
    } finally {
      if (don) don();
      dangChay = false;
    }
  }

  router.post('/import/cellseeker', requireAdmin, nhanNhap, (req, res) => {
    const kieuDem = (req.body || {}).kieu_dem === 'cot' ? 'cot' : 'hang';
    return xuLy(req, res, 'cellseeker', async (buf) => {
      const tam = Nhap.giaiNenZip(buf);
      try {
        return { ke: Nhap.lapKeHoach(Nhap.docThuMuc(tam.dir), { kieuDem }), don: tam.don };
      } catch (e) {
        tam.don();
        throw e;
      }
    });
  });

  router.post('/import/excel', requireAdmin, nhanNhap, (req, res) => xuLy(req, res, 'excel', async (buf) => ({ ke: await Excel.docExcel(buf) })));

  router.get('/containers/:id/export.xlsx', requireManage, async (req, res) => {
    const id = toInt(req.params.id);
    try {
      const goc = id && db.prepare('SELECT ngan_hang FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!goc || goc.ngan_hang !== req.nganHang) return fail(res, 404, 'Không tìm thấy thiết bị.');
      const x = await Excel.xuatThietBi(db, id);
      audit(req, 'container_export_xlsx', `id=${id} ${x.tenTep}: ${x.thongKe.ong} ống, ${x.thongKe.hop} hộp, ${x.thongKe.dong} dòng`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(x.tenTep)}`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(x.buffer);
    } catch (e) {
      if (e instanceof Excel.LoiNguoiDung) return fail(res, e.status, e.message);
      throw e;
    }
  });

  return router;
};
