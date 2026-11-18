'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — tệp đính kèm của dòng tế bào / lô / kết quả QC (phiếu dữ liệu, kết quả mycoplasma, STR, ảnh hình thái...). 3 endpoint.
 * Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 *
 * An toàn: chỉ nhận PDF, ảnh PNG / JPG / WEBP, Excel / Word (.xlsx / .docx), .txt và .csv; loại tệp nhận dạng theo NỘI DUNG (đầu tệp) khớp phần mở rộng, KHÔNG tin
 * Content-Type do người dùng gửi; tối đa 10 MB, 20 tệp mỗi đối tượng. Tệp lưu dưới thư mục uploads/ngan-hang với tên ngẫu nhiên (không dùng tên người dùng
 * trong đường dẫn nên không đi vòng được); tải về qua API có đăng nhập, ép tên tệp, nosniff và CSP chặn chạy mã (ảnh hiện trực tiếp, loại khác tải về).
 * Xóa chỉ đánh dấu (giữ tệp và dòng ghi để truy vết). Quyền thêm / xóa như sửa dòng tế bào: người tạo dòng hoặc quản lý.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const appPaths = require('../../lib/appPaths');
const { toInt, toStr } = require('../../services/nganHangTeBaoKhangThe');
const DT = require('../../services/nganHangTeBaoKhangTheDongTeBao');

module.exports = function createTepRouter(ctx, deps = {}) {
  const { db, canManage, audit, fail, nhanNguoi } = ctx;
  const router = express.Router();
  const goc = path.join(deps.uploadsRoot || appPaths.uploadsRoot(), 'ngan-hang');
  const KHOA_HOP_LE = /^\d{4}\/[0-9a-f]{32}$/;

  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: DT.TOI_DA_TEP, files: 1, fields: 6, parts: 8 } });

  /** Tên tệp multer có thể còn ở dạng latin1 (UTF-8 bị đọc sai); chuỗi đã có ký tự > 255 là đã giải mã đúng. */
  function giaiMaTen(ten) {
    const raw = String(ten || 'tep');
    if ([...raw].some((c) => c.charCodeAt(0) > 255)) return raw;
    const thu = Buffer.from(raw, 'latin1').toString('utf8');
    return thu.includes('\ufffd') ? raw : thu;
  }

  router.post('/attachments', (req, res, next) => {
    if (req.nganHang !== 'te_bao') return fail(res, 400, 'Tệp đính kèm dòng tế bào chỉ dùng ở ngân hàng tế bào.');
    upload.single('tep')(req, res, (e) => {
      if (e) return fail(res, 400, e.code === 'LIMIT_FILE_SIZE' ? `Tệp quá lớn (tối đa ${DT.TOI_DA_TEP / 1048576} MB).` : 'Không nhận được tệp: ' + e.message);
      next();
    });
  }, (req, res) => {
    const b = req.body || {};
    const loai = b.doi_tuong;
    const doiId = toInt(b.doi_tuong_id);
    if (!['dong', 'lo', 'qc'].includes(loai) || !doiId) return fail(res, 400, 'Đối tượng đính kèm không hợp lệ (dòng, lô hoặc kết quả QC).');
    const dong = ctx.dongCuaDoiTuong(loai, doiId);
    if (!dong) return fail(res, 404, 'Không tìm thấy đối tượng để đính kèm.');
    if (!canManage(req) && dong.created_by !== req.user.id) return fail(res, 403, 'Chỉ người tạo dòng hoặc quản lý mới đính kèm được tệp.');
    if (!req.file) return fail(res, 400, 'Chưa chọn tệp.');
    const ten = DT.lamSachTen(giaiMaTen(req.file.originalname));
    const ext = DT.nhanDangTep(req.file.buffer, ten);
    if (!ext) return fail(res, 400, 'Chỉ nhận PDF, ảnh PNG / JPG / WEBP, .xlsx, .docx, .txt, .csv, và nội dung tệp phải đúng với phần mở rộng.');
    const da = db.prepare('SELECT COUNT(*) AS c FROM nhm_tep WHERE doi_tuong = ? AND doi_tuong_id = ? AND xoa_luc IS NULL').get(loai, doiId).c;
    if (da >= DT.TOI_DA_TEP_MOI_DOI_TUONG) return fail(res, 409, `Mỗi mục chỉ đính kèm tối đa ${DT.TOI_DA_TEP_MOI_DOI_TUONG} tệp.`);
    const nam = String(new Date().getUTCFullYear());
    const khoa = `${nam}/${crypto.randomBytes(16).toString('hex')}`;
    const duongDan = path.join(goc, nam, khoa.split('/')[1]);
    try {
      fs.mkdirSync(path.dirname(duongDan), { recursive: true });
      fs.writeFileSync(duongDan, req.file.buffer, { flag: 'wx' });
    } catch (e) {
      console.error('[ngan-hang] ghi tệp đính kèm lỗi:', e.message);
      return fail(res, 500, 'Không lưu được tệp trên máy chủ.');
    }
    try {
      const info = db
        .prepare('INSERT INTO nhm_tep (doi_tuong, doi_tuong_id, ten_goc, mime, kich_thuoc, khoa, sha256, mo_ta, tao_boi, tao_boi_ten) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(loai, doiId, ten, DT.LOAI_TEP[ext].mime, req.file.size, khoa, crypto.createHash('sha256').update(req.file.buffer).digest('hex'), toStr(b.mo_ta, 200), req.user.id, nhanNguoi(req.user.id));
      audit(req, 'attachment_create', `#${info.lastInsertRowid} ${loai} ${doiId} dòng ${dong.ma}: ${ten} (${req.file.size} byte)`);
      res.status(201).json({ id: Number(info.lastInsertRowid), ten_goc: ten, kich_thuoc: req.file.size });
    } catch (e) {
      try { fs.unlinkSync(duongDan); } catch (_) { /* tệp mồ côi vô hại */ }
      throw e;
    }
  });

  function layTep(req, res) {
    const id = toInt(req.params.id);
    const t = id && db.prepare('SELECT * FROM nhm_tep WHERE id = ? AND xoa_luc IS NULL').get(id);
    const dong = t && ctx.dongCuaDoiTuong(t.doi_tuong, t.doi_tuong_id);
    if (!t || !dong) { fail(res, 404, 'Không tìm thấy tệp đính kèm.'); return null; }
    return { t, dong };
  }

  router.get('/attachments/:id/download', (req, res) => {
    if (req.nganHang !== 'te_bao') return fail(res, 400, 'Tệp đính kèm dòng tế bào chỉ dùng ở ngân hàng tế bào.');
    const x = layTep(req, res);
    if (!x) return;
    if (!KHOA_HOP_LE.test(x.t.khoa)) return fail(res, 404, 'Tệp không hợp lệ.');
    const duongDan = path.join(goc, ...x.t.khoa.split('/'));
    if (!fs.existsSync(duongDan)) return fail(res, 404, 'Tệp không còn trên máy chủ.');
    const anh = /^image\//.test(x.t.mime);
    res.setHeader('Content-Type', x.t.mime);
    res.setHeader('Content-Length', String(fs.statSync(duongDan).size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `${anh ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(x.t.ten_goc)}`);
    audit(req, 'attachment_download', `#${x.t.id} ${x.t.ten_goc}`);
    fs.createReadStream(duongDan).on('error', () => res.destroy()).pipe(res);
  });

  router.delete('/attachments/:id', (req, res) => {
    if (req.nganHang !== 'te_bao') return fail(res, 400, 'Tệp đính kèm dòng tế bào chỉ dùng ở ngân hàng tế bào.');
    const x = layTep(req, res);
    if (!x) return;
    if (!canManage(req) && x.dong.created_by !== req.user.id && x.t.tao_boi !== req.user.id) return fail(res, 403, 'Chỉ người tạo dòng, người đính kèm hoặc quản lý mới xóa được tệp.');
    db.prepare("UPDATE nhm_tep SET xoa_luc = datetime('now'), xoa_boi = ? WHERE id = ?").run(req.user.id, x.t.id);
    audit(req, 'attachment_delete', `#${x.t.id} ${x.t.ten_goc}`);
    res.json({ ok: true });
  });

  return router;
};
