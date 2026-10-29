/**
 * Hồ sơ trình Viện trưởng của một đợt báo cáo — router con của routes/baoCaoPhong.js.
 *
 * Mount: router.use('/dot/:id/trinh', canQuanLy, createTrinhRouter({...}))
 * Nên MỌI đường ở đây đã qua canQuanLy (quản lý module, Viện trưởng, hoặc admin hệ thống).
 * Trưởng phòng không thấy hồ sơ này: đó là bộ báo cáo gộp của nhiều phòng.
 *
 * Luồng:   chua_gui ──Gửi──▶ da_gui ──Viện trưởng duyệt──▶ da_duyet
 *                              │ ▲
 *                              └─┘ Gửi lại (nhắc Viện trưởng), tải lên/xóa tệp thoải mái
 *   chua_gui : quản lý module chuẩn bị — tải lên / xóa tệp (bản kết xuất Word/PDF đã chỉnh, đã ký…)
 *   da_gui   : "CHƯA DUYỆT". Đã báo Viện trưởng; chưa duyệt thì cứ để vậy, không phải sự cố. Quản lý module có
 *              thể kết xuất lại, đổi tệp rồi GỬI LẠI để nhắc việc. Không có "từ chối": không duyệt = chưa duyệt.
 *   da_duyet : xong, khóa tệp. CHỈ Viện trưởng duyệt được — quản lý module và admin KHÔNG duyệt thay.
 *   (cột duyet_thay của bảng chỉ còn để tương thích dữ liệu cũ, luôn 0.)
 *
 * Bảo mật tệp — nơi dễ sai nhất của cả module:
 *   - Chỉ nhận .pdf / .docx / .doc, VÀ kiểm byte đầu của tệp khớp loại (đuôi có thể bị đổi tên).
 *   - Lưu dưới tên NGẪU NHIÊN trên đĩa; tên người dùng đặt chỉ ở DB để hiển thị. Không bao giờ ghép
 *     tên do người dùng đưa vào đường dẫn → không có path traversal.
 *   - Không để tệp trong thư mục phục vụ tĩnh; chỉ tải được qua endpoint này, sau canQuanLy.
 *   - Tải về luôn kèm nosniff và no-store.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const upload = require('../lib/upload');
const { contentDisposition } = require('../lib/filenames');

const LOAI_TEP = {
  '.pdf': { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [0x50, 0x4b, 0x03, 0x04] }, // PK.. (zip)
  '.doc': { mime: 'application/msword', magic: [0xd0, 0xcf, 0x11, 0xe0] }, // OLE2
};
/** Xóa tệp ĐỒNG BỘ rồi mới trả lời: tệp nhỏ nên chi phí không đáng kể, và nhờ đó khi client nhận được
 *  phản hồi thì trên đĩa chắc chắn đã sạch (không có khoảnh khắc 'bị từ chối nhưng tệp còn đó'). */
function xoaTep(duongDan) {
  try {
    fs.unlinkSync(duongDan);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[bao-cao-phong] không xóa được tệp:', e.code);
  }
}

const TEN_LUU_HOP_LE = /^[a-f0-9]{32}\.(pdf|docx|doc)$/;
const TOI_DA_TEP = 10;
const TOI_DA_BYTE = 25 * 1024 * 1024;

module.exports = function createTrinhRouter({ db, uploadsRoot, thongBao, guiNen, loi, bao, docId }) {
  const router = express.Router({ mergeParams: true });

  const thuMucDot = (dotId) => path.join(uploadsRoot, 'bao-cao-phong', String(dotId));

  function ghiLichSu(dotId, hanhDong, nguoiId, ghiChu) {
    db.prepare('INSERT INTO bcp_dot_lich_su (dot_id, hanh_dong, nguoi_id, ghi_chu) VALUES (?,?,?,?)').run(dotId, hanhDong, nguoiId, ghiChu || null);
  }

  // Nạp đợt; hồ sơ trình chỉ có nghĩa khi đợt đã mở (đợt Nháp chưa có báo cáo nào để trình).
  router.use((req, res, next) => {
    const id = docId(req.params.id);
    if (!id) return loi(res, 400, 'ID không hợp lệ.');
    const dot = db.prepare('SELECT id, tieu_de, trang_thai FROM bcp_dot WHERE id = ?').get(id);
    if (!dot) return loi(res, 404, 'Không tìm thấy đợt báo cáo.');
    if (dot.trang_thai === 'nhap') return loi(res, 409, 'Đợt còn ở trạng thái Nháp, chưa có báo cáo để trình.');
    req.dotTrinh = dot;
    next();
  });

  const layTrinh = (dotId) => db.prepare('SELECT * FROM bcp_trinh WHERE dot_id = ?').get(dotId);
  const batBuocCoTrinh = (dotId) => db.prepare('INSERT OR IGNORE INTO bcp_trinh (dot_id) VALUES (?)').run(dotId);
  const dsVienTruong = () =>
    db.prepare("SELECT u.id, u.fullname FROM bcp_thanh_vien t JOIN users u ON u.id = t.user_id WHERE t.vai_tro = 'vien_truong' ORDER BY u.fullname").all();

  // ── Xem ────────────────────────────────────────────────────────────────────
  router.get(
    '/',
    bao((req, res) => {
      const dotId = req.dotTrinh.id;
      const t = layTrinh(dotId) || { trang_thai: 'chua_gui' };
      const tep = db
        .prepare(
          `SELECT f.id, f.ten_goc, f.loai, f.kich_thuoc, f.tai_luc, u.fullname AS nguoi_tai
             FROM bcp_trinh_tep f LEFT JOIN users u ON u.id = f.nguoi_tai_id WHERE f.dot_id = ? ORDER BY f.id`
        )
        .all(dotId);
      const lichSu = db
        .prepare(
          `SELECT h.hanh_dong, h.ghi_chu, h.tao_luc, u.fullname AS nguoi
             FROM bcp_dot_lich_su h LEFT JOIN users u ON u.id = h.nguoi_id WHERE h.dot_id = ? ORDER BY h.id`
        )
        .all(dotId);
      const vt = dsVienTruong();
      const nguoiGui = t.nguoi_gui_id ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(t.nguoi_gui_id) : null;
      const nguoiDuyet = t.nguoi_duyet_id ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(t.nguoi_duyet_id) : null;

      let lyDoKhongGui = null;
      if (t.trang_thai !== 'da_duyet') {
        if (tep.length === 0) lyDoKhongGui = 'Hãy tải lên ít nhất một tệp (bản kết xuất báo cáo) trước khi gửi.';
        else if (vt.length === 0) lyDoKhongGui = 'Chưa chỉ định Viện trưởng. Quản trị viên cần gán vai trò Viện trưởng trong mục Phòng & phân quyền.';
      }
      res.json({
        trinh: {
          trang_thai: t.trang_thai,
          loi_nhan: t.loi_nhan || null,
          gui_luc: t.gui_luc || null,
          nguoi_gui: nguoiGui ? nguoiGui.fullname : null,
          duyet_luc: t.duyet_luc || null,
          nguoi_duyet: nguoiDuyet ? nguoiDuyet.fullname : null,
          nhan_xet: t.nhan_xet || null,
        },
        tep,
        lich_su: lichSu,
        vien_truong: vt.map((x) => x.fullname),
        la_vien_truong: req.bcp.laVienTruong,
        co_the: {
          tai_len: t.trang_thai !== 'da_duyet' && tep.length < TOI_DA_TEP,
          gui: t.trang_thai !== 'da_duyet' && tep.length > 0 && vt.length > 0, // da_gui: gửi lại để nhắc
          duyet: t.trang_thai === 'da_gui' && req.bcp.laVienTruong,
        },
        ly_do_khong_gui: lyDoKhongGui,
        toi_da_tep: TOI_DA_TEP,
        toi_da_mb: TOI_DA_BYTE / (1024 * 1024),
      });
    })
  );

  // ── Tải tệp lên ─────────────────────────────────────────────────────────────
  /** Kiểm trạng thái TRƯỚC khi multer nhận file, để một yêu cầu bị từ chối không để lại tệp trên đĩa. */
  function choPhepTaiLen(req, res, next) {
    const t = layTrinh(req.dotTrinh.id);
    if (t && t.trang_thai === 'da_duyet') return loi(res, 409, 'Hồ sơ đã được duyệt, không thêm tệp được.');
    const n = db.prepare('SELECT COUNT(*) AS n FROM bcp_trinh_tep WHERE dot_id = ?').get(req.dotTrinh.id).n;
    if (n >= TOI_DA_TEP) return loi(res, 409, `Mỗi hồ sơ tối đa ${TOI_DA_TEP} tệp.`);
    next();
  }

  const nhanMotTep = upload({
    storage: upload.diskStorage({
      destination(req, file, cb) {
        const dir = thuMucDot(req.dotTrinh.id);
        fs.mkdir(dir, { recursive: true }, (e) => cb(e, dir));
      },
      // Tên ngẫu nhiên + đuôi đã kiểm trong fileFilter. Tên người dùng đặt KHÔNG đi vào đường dẫn.
      filename(req, file, cb) {
        cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase());
      },
    }),
    limits: { fileSize: TOI_DA_BYTE, files: 1 },
    fileFilter(req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!LOAI_TEP[ext]) return cb(Object.assign(new Error('Chỉ nhận tệp PDF hoặc Word (.pdf, .docx, .doc).'), { code: 'LOAI_TEP' }));
      cb(null, true);
    },
  }).single('tep');

  /** Đọc vài byte đầu: đuôi .pdf nhưng ruột là thứ khác thì từ chối. */
  function dungDinhDang(file, ext) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      return LOAI_TEP[ext].magic.every((b, i) => buf[i] === b);
    } catch (_) {
      return false;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* bỏ qua */ }
    }
  }

  router.post('/tep', choPhepTaiLen, (req, res) => {
    nhanMotTep(req, res, (err) => {
      try {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') return loi(res, 413, `Tệp quá lớn (tối đa ${TOI_DA_BYTE / (1024 * 1024)} MB).`);
          if (err.code === 'LOAI_TEP') return loi(res, 400, err.message);
          if (err.code && String(err.code).startsWith('LIMIT_')) return loi(res, 400, 'Yêu cầu tải lên không hợp lệ.');
          console.error('[bao-cao-phong] tải tệp lỗi:', err);
          return loi(res, 500, 'Không lưu được tệp.');
        }
        if (!req.file) return loi(res, 400, 'Chưa chọn tệp.');
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (!dungDinhDang(req.file.path, ext)) {
          xoaTep(req.file.path);
          return loi(res, 400, 'Nội dung tệp không đúng định dạng ' + ext.slice(1).toUpperCase() + '.');
        }
        batBuocCoTrinh(req.dotTrinh.id);
        const r = db
          .prepare('INSERT INTO bcp_trinh_tep (dot_id, ten_goc, ten_luu, loai, kich_thuoc, nguoi_tai_id) VALUES (?,?,?,?,?,?)')
          .run(req.dotTrinh.id, req.file.originalname.slice(0, 200), req.file.filename, ext.slice(1), req.file.size, req.user.id);
        ghiLichSu(req.dotTrinh.id, 'tai_tep', req.user.id, req.file.originalname.slice(0, 200));
        res.status(201).json({ id: Number(r.lastInsertRowid) });
      } catch (e) {
        if (req.file) xoaTep(req.file.path);
        console.error('[bao-cao-phong] tải tệp lỗi:', e);
        if (!res.headersSent) loi(res, 500, 'Không lưu được tệp.');
      }
    });
  });

  router.delete(
    '/tep/:tid',
    bao((req, res) => {
      const tid = docId(req.params.tid);
      if (!tid) return loi(res, 400, 'ID không hợp lệ.');
      const t = layTrinh(req.dotTrinh.id);
      if (t && t.trang_thai === 'da_duyet') return loi(res, 409, 'Hồ sơ đã được duyệt, không xóa tệp được.');
      const f = db.prepare('SELECT id, ten_goc, ten_luu FROM bcp_trinh_tep WHERE id = ? AND dot_id = ?').get(tid, req.dotTrinh.id);
      if (!f) return loi(res, 404, 'Không tìm thấy tệp.');
      db.prepare('DELETE FROM bcp_trinh_tep WHERE id = ?').run(tid);
      if (TEN_LUU_HOP_LE.test(f.ten_luu)) xoaTep(path.join(thuMucDot(req.dotTrinh.id), f.ten_luu));
      ghiLichSu(req.dotTrinh.id, 'xoa_tep', req.user.id, f.ten_goc);
      res.json({ ok: true });
    })
  );

  router.get(
    '/tep/:tid/tai',
    bao((req, res) => {
      const tid = docId(req.params.tid);
      if (!tid) return loi(res, 400, 'ID không hợp lệ.');
      const f = db.prepare('SELECT ten_goc, ten_luu, loai FROM bcp_trinh_tep WHERE id = ? AND dot_id = ?').get(tid, req.dotTrinh.id);
      // Phòng thủ chiều sâu: ten_luu do chính server sinh ra, nhưng vẫn không tin dòng DB mù quáng
      // trước khi ghép vào đường dẫn đĩa.
      if (!f || !TEN_LUU_HOP_LE.test(f.ten_luu)) return loi(res, 404, 'Không tìm thấy tệp.');
      const duongDan = path.join(thuMucDot(req.dotTrinh.id), f.ten_luu);
      const meta = LOAI_TEP['.' + f.loai];
      const luong = fs.createReadStream(duongDan);
      luong.on('error', () => {
        if (!res.headersSent) loi(res, 404, 'Tệp không còn trên máy chủ.');
        else res.destroy();
      });
      luong.on('open', () => {
        res.setHeader('Content-Type', meta ? meta.mime : 'application/octet-stream');
        res.setHeader('Content-Disposition', contentDisposition(f.ten_goc));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        luong.pipe(res);
      });
    })
  );

  // ── Gửi (và gửi lại) / duyệt ────────────────────────────────────────────────
  router.post(
    '/gui',
    bao((req, res) => {
      const dotId = req.dotTrinh.id;
      const soTep = db.prepare('SELECT COUNT(*) AS n FROM bcp_trinh_tep WHERE dot_id = ?').get(dotId).n;
      if (soTep === 0) return loi(res, 409, 'Chưa có tệp nào để gửi.');
      if (dsVienTruong().length === 0) return loi(res, 409, 'Chưa chỉ định Viện trưởng. Quản trị viên cần gán vai trò Viện trưởng trước.');
      const loiNhan = typeof (req.body && req.body.loi_nhan) === 'string' ? req.body.loi_nhan.trim().slice(0, 1000) : '';
      batBuocCoTrinh(dotId);
      const guiLai = (layTrinh(dotId) || {}).trang_thai === 'da_gui';
      // Gửi lại (nhắc Viện trưởng) được phép khi chưa duyệt; đã duyệt thì khóa. Điều kiện nằm ngay trong UPDATE.
      const r = db
        .prepare(
          `UPDATE bcp_trinh
              SET trang_thai = 'da_gui', loi_nhan = ?, nguoi_gui_id = ?, gui_luc = ?,
                  nguoi_duyet_id = NULL, duyet_luc = NULL, nhan_xet = NULL, cap_nhat_luc = datetime('now')
            WHERE dot_id = ? AND trang_thai IN ('chua_gui','da_gui')`
        )
        .run(loiNhan || null, req.user.id, new Date().toISOString(), dotId);
      if (r.changes === 0) return loi(res, 409, 'Hồ sơ đã được Viện trưởng duyệt rồi.');
      ghiLichSu(dotId, guiLai ? 'gui_lai' : 'gui', req.user.id, loiNhan);
      guiNen(thongBao.baoDaGuiVienTruong(dotId, req.user.id, guiLai));
      res.json({ ok: true, trang_thai: 'da_gui', gui_lai: guiLai });
    })
  );

  router.post(
    '/duyet',
    bao((req, res) => {
      const dotId = req.dotTrinh.id;
      // Chỉ Viện trưởng (được gán trong module) duyệt. Quản lý module và admin hệ thống KHÔNG duyệt thay.
      if (!req.bcp.laVienTruong) return loi(res, 403, 'Chỉ Viện trưởng mới duyệt được hồ sơ này.');
      const nhanXet = typeof (req.body && req.body.nhan_xet) === 'string' ? req.body.nhan_xet.trim().slice(0, 2000) : '';
      const r = db
        .prepare(
          `UPDATE bcp_trinh
              SET trang_thai = 'da_duyet', nguoi_duyet_id = ?, duyet_luc = ?, nhan_xet = ?, cap_nhat_luc = datetime('now')
            WHERE dot_id = ? AND trang_thai = 'da_gui'`
        )
        .run(req.user.id, new Date().toISOString(), nhanXet || null, dotId);
      if (r.changes === 0) return loi(res, 409, 'Chỉ duyệt được hồ sơ đang ở trạng thái Đã gửi, chờ duyệt.');
      ghiLichSu(dotId, 'duyet', req.user.id, nhanXet);
      guiNen(thongBao.baoDaDuyetTrinh(dotId, req.user.id));
      res.json({ ok: true, trang_thai: 'da_duyet' });
    })
  );

  return router;
};
