'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — NHẬP DỮ LIỆU từ tệp xuất của Cellseeker ngay trên giao diện (Quản lý module → Nhập dữ liệu). 1 endpoint, chỉ Admin.
 * Logic: services/nganHangTeBaoKhangTheNhapCellseeker.js (cũng có bản dòng lệnh scripts/nhap-cellseeker.js).
 *
 * POST /import/cellseeker  (multipart: tep = .zip; kieu_dem = hang | cot; ghi = 1 để ghi thật, không có = chỉ KIỂM TRA)
 *   Kiểm tra làm mọi bước trong một giao dịch rồi hủy nên số liệu đúng như khi ghi thật, nhưng không đổi gì. Ghi thật là một giao dịch duy nhất
 *   (lỗi thì không có gì được ghi) và chỉ THÊM dữ liệu: không sửa, không xóa; nhập lại không tạo trùng. Trước khi ghi có sao lưu CSDL (nếu làm được).
 *   Tệp .zip được giải nén vào thư mục tạm (chỉ lấy *.csv và stock-attachments/, tên tệp lấy phần cuối, chặn zip nén quá mức) rồi xóa ngay.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const appPaths = require('../../lib/appPaths');
const Nhap = require('../../services/nganHangTeBaoKhangTheNhapCellseeker');

const TOI_DA_ZIP = 80 * 1048576;

module.exports = function createNhapDuLieuRouter(ctx, deps = {}) {
  const { db, requireAdmin, audit, fail } = ctx;
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: TOI_DA_ZIP, files: 1, fields: 6, parts: 8 } });
  let dangChay = false; // đồng bộ cả hai bước kiểm tra / ghi: mỗi lúc chỉ một lần nhập

  /** Sao lưu CSDL trước khi ghi (best effort). Trả tên tệp hoặc null. */
  async function saoLuu() {
    try {
      if (!db.name || db.name === ':memory:' || !fs.existsSync(db.name)) return null;
      const thuMuc = path.join(path.dirname(db.name), 'backups');
      fs.mkdirSync(thuMuc, { recursive: true });
      const ten = `truoc-cellseeker-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.db`;
      await db.backup(path.join(thuMuc, ten));
      return ten;
    } catch (e) {
      console.warn('[ngan-hang] sao lưu trước khi nhập Cellseeker lỗi:', e && e.message);
      return null;
    }
  }

  router.post(
    '/import/cellseeker',
    requireAdmin,
    (req, res, next) => {
      if (req.nganHang !== 'te_bao') return fail(res, 400, 'Nhập dữ liệu Cellseeker chỉ dùng ở ngân hàng tế bào.');
      upload.single('tep')(req, res, (e) => {
        if (e) return fail(res, 400, e.code === 'LIMIT_FILE_SIZE' ? `Tệp quá lớn (tối đa ${TOI_DA_ZIP / 1048576} MB).` : 'Không nhận được tệp: ' + e.message);
        next();
      });
    },
    async (req, res) => {
      if (!req.file) return fail(res, 400, 'Chưa chọn tệp .zip xuất từ Cellseeker.');
      const b = req.body || {};
      const ghi = b.ghi === '1' || b.ghi === 'true';
      const kieuDem = b.kieu_dem === 'cot' ? 'cot' : 'hang';
      if (dangChay) return fail(res, 409, 'Đang có một lần nhập khác chạy. Đợi xong rồi thử lại.');
      dangChay = true;
      let tam = null;
      try {
        tam = Nhap.giaiNenZip(req.file.buffer);
        const ke = Nhap.lapKeHoach(Nhap.docThuMuc(tam.dir), { kieuDem });
        const sao = ghi ? await saoLuu() : null;
        const kq = Nhap.thucThi(db, ke, { nguoiId: req.user.id, ghi, uploadsRoot: deps.uploadsRoot || appPaths.uploadsRoot() });
        const t = (x) => x.length;
        const dem = { thiet_bi: t(ke.thietBi), rack: ke.thietBi.reduce((n, x) => n + x.rack.length, 0), hop: ke.thietBi.reduce((n, x) => n + x.rack.reduce((m, r) => m + r.hop.length, 0), 0), dong: t(ke.dong), lo: t(ke.lo), ong: t(ke.ong), tep: t(ke.tepLo) };
        if (ghi) audit(req, 'import_cellseeker', `${req.file.originalname}: mới ${kq.dong.moi} dòng, ${kq.lo.moi} lô, ${kq.ong.moi} ống, ${kq.hop.moi} hộp, ${kq.tep.moi} tệp (bỏ qua ${kq.ong.boQua} ống); cách đếm ô: ${kieuDem}`);
        res.json({ da_ghi: ghi, kieu_dem: kieuDem, trong_tep: dem, ket_qua: kq, vi_du: ke.viDu, sao_luu: sao });
      } catch (e) {
        if (e && e.code && String(e.code).startsWith('SQLITE')) {
          console.error('[ngan-hang] nhập Cellseeker lỗi CSDL:', e.message);
          return fail(res, 500, 'Lỗi cơ sở dữ liệu khi nhập: không có gì được ghi (giao dịch đã hủy).');
        }
        return fail(res, 400, e && e.message ? e.message : 'Không nhập được.'); // lỗi do dữ liệu / tệp: thông báo tiếng Việt của dịch vụ nhập
      } finally {
        if (tam) tam.don();
        dangChay = false;
      }
    }
  );

  return router;
};
