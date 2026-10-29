/**
 * Báo cáo phòng ban — Trưởng phòng Tổ chức Hành chính giao đợt báo cáo, các trưởng phòng
 * nhập báo cáo trực tiếp theo biểu mẫu, người quản lý xác nhận hoặc yêu cầu chỉnh sửa.
 *
 * TỪ NGỮ: "xác nhận" = quản lý module kiểm báo cáo của TỪNG PHÒNG (trạng thái nội bộ da_duyet, đường /bao-cao/:id/duyet);
 * "duyệt" CHỈ dành cho Viện trưởng duyệt HỒ SƠ TRÌNH. Hai việc khác nhau, nên hai từ khác nhau trên giao diện và email.
 *
 * Mount (server.js): app.use('/api/bao-cao-phong', authMiddleware, createBaoCaoPhongRouter({ db }))
 *
 * Hai vai trò, lưu trong bảng bcp_thanh_vien — KHÔNG đụng vào cột users.role dùng chung:
 *   quan_ly      — người quản lý module: dựng biểu mẫu, giao đợt, duyệt, phân quyền.
 *                  Admin hệ thống mặc nhiên là quan_ly.
 *   truong_phong — gắn với một phòng; chỉ thấy và nhập báo cáo của phòng mình.
 *
 * Phân quyền chặn ở ĐÂY (server), không dựa vào việc giao diện ẩn nút. Báo cáo ngoài phạm
 * vi của người gọi trả 404 chứ không phải 403, để không lộ id nào đang tồn tại.
 *
 * Thứ tự route: các đường tĩnh (vd. /phong/nhap-tu-don-vi) khai báo TRƯỚC đường có :id.
 */

const express = require('express');
const crypto = require('crypto');
const { ensureSchema } = require('../services/baoCaoPhongSchema');
const { chuanHoaMau, kiemTraDuLieu } = require('../services/baoCaoPhongMau');
const { taoThongBao } = require('../services/baoCaoPhongThongBao');
const { taoNhacHan } = require('../services/baoCaoPhongNhacHan');
const Xuat = require('../services/baoCaoPhongXuat');
const { contentDisposition } = require('../lib/filenames');
const createTrinhRouter = require('./baoCaoPhongTrinh');

const LOAI_DOT = ['tuan', 'thang', 'quy', 'nam', 'dot_xuat'];
const NGAY = /^\d{4}-\d{2}-\d{2}$/;
const MA_PHONG = /^[a-z0-9][a-z0-9_-]{0,29}$/;
const TRANG_THAI_SUA_DUOC = ['chua_nop', 'can_chinh_sua'];

const GIO_VN_MS = 7 * 3600 * 1000;

/** Ngày theo giờ Việt Nam (AAAA-MM-DD). Server có thể chạy múi giờ UTC nên không dùng getDate() trực tiếp. */
function ngayVN(d) {
  const t = d instanceof Date ? d : new Date(d);
  return new Date(t.getTime() + GIO_VN_MS).toISOString().slice(0, 10);
}

function ngayThat(s) {
  if (typeof s !== 'string' || !NGAY.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function docId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function chuoi(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return max ? t.slice(0, max) : t;
}

function parseJson(text, macDinh) {
  try {
    const v = JSON.parse(text);
    return v == null ? macDinh : v;
  } catch (_) {
    return macDinh;
  }
}

/** Báo cáo trễ hạn: chưa nộp mà đã qua ngày hạn, hoặc nộp vào sau ngày hạn. */
function treHan(bc, dot, homNay) {
  if (bc.trang_thai === 'da_nop' || bc.trang_thai === 'da_duyet') {
    return !!bc.nop_luc && ngayVN(bc.nop_luc) > dot.han_nop;
  }
  return dot.trang_thai !== 'nhap' && homNay > dot.han_nop;
}

/**
 * @param {{db:object, mailSend?:Function, uploadsRoot?:string, baseUrl?:string}} deps
 *   mailSend — gửi email (nodemailer của server.js); thiếu thì module chạy bình thường, chỉ không gửi thư.
 *   uploadsRoot — thư mục gốc lưu tệp tải lên; thiếu thì bỏ phần hồ sơ trình Viện trưởng.
 *   baseUrl — gốc địa chỉ để đặt liên kết trong email.
 *   nhacTuDong — true thì bật hẹn giờ tự nhắc trước hạn (chỉ server thật; test gọi router.nhacHan.chayMotLan trực tiếp).
 */
module.exports = function createBaoCaoPhongRouter({ db, mailSend, uploadsRoot, baseUrl, nhacTuDong }) {
  const router = express.Router();

  // Module phụ không được phép làm sập cả hệ thống đang chạy thật: nếu khởi tạo bảng lỗi
  // (vd. driver Turso không hỗ trợ một câu lệnh), server vẫn lên, riêng module này trả 503.
  try {
    ensureSchema(db);
  } catch (e) {
    console.error('[bao-cao-phong] Không khởi tạo được lược đồ, module bị tắt:', e.message);
    router.use((req, res) => res.status(503).json({ message: 'Module Báo cáo phòng ban chưa sẵn sàng.' }));
    return router;
  }

  const loi = (res, status, message, extra) => res.status(status).json({ message, ...(extra || {}) });

  const thongBao = taoThongBao({ db, mailSend, baseUrl });
  router.nhacHan = taoNhacHan({ db, thongBao });
  if (nhacTuDong) router.nhacHan.batDau();
  /** Thư báo chạy NỀN: không chờ, không để lỗi (SMTP, mạng…) làm hỏng thao tác chính đã thành công. */
  const guiNen = (p) => Promise.resolve(p).catch((e) => console.warn('[bao-cao-phong] thông báo lỗi:', e && e.message));

  /** Bọc handler (đồng bộ hoặc async): lỗi bất ngờ ra 500 chung chung, chi tiết chỉ vào log. */
  const bao = (fn) => (req, res) => {
    const xuLyLoi = (e) => {
      console.error('[bao-cao-phong]', req.method, req.originalUrl, e);
      if (!res.headersSent) loi(res, 500, 'Có lỗi hệ thống. Vui lòng thử lại.');
    };
    try {
      const kq = fn(req, res);
      if (kq && typeof kq.catch === 'function') kq.catch(xuLyLoi);
      return kq;
    } catch (e) {
      return xuLyLoi(e);
    }
  };

  // ── Ngữ cảnh quyền của người gọi ───────────────────────────────────────────
  router.use((req, res, next) => {
    const u = req.user;
    if (!u || !u.id) return loi(res, 401, 'Chưa đăng nhập');
    const laAdmin = String(u.role || '').toLowerCase() === 'admin';
    const rows = db.prepare('SELECT vai_tro, phong_id FROM bcp_thanh_vien WHERE user_id = ?').all(u.id);
    // Viện trưởng xem và quản lý chung như người quản lý (laQuanLy: xếp vào module "luôn") và là người DUYỆT hồ sơ
    // trình, nhưng KHÔNG phải người xác nhận báo cáo từng phòng hay tải/gửi hồ sơ: đó là việc của người quản lý module
    // (laQuanLyModule = admin hoặc có dòng quan_ly). Vai trò chung users.role = 'vien_truong' KHÔNG tự cho quyền ở
    // đây: phải được gán rõ trong bcp_thanh_vien.
    const laVienTruong = rows.some((r) => r.vai_tro === 'vien_truong');
    const laQuanLyModule = laAdmin || rows.some((r) => r.vai_tro === 'quan_ly');
    req.bcp = {
      laAdmin,
      laVienTruong,
      laQuanLyModule,
      laQuanLy: laAdmin || laVienTruong || laQuanLyModule,
      phongIds: rows.filter((r) => r.vai_tro === 'truong_phong').map((r) => r.phong_id),
    };
    next();
  });

  const canQuanLy = (req, res, next) =>
    req.bcp.laQuanLy ? next() : loi(res, 403, 'Chỉ người quản lý module Báo cáo phòng ban mới thực hiện được.');

  /** Xác nhận / yêu cầu chỉnh sửa báo cáo TỪNG PHÒNG: người quản lý module (và admin), không phải Viện trưởng. */
  const canXacNhan = (req, res, next) =>
    req.bcp.laQuanLyModule ? next() : loi(res, 403, 'Chỉ người quản lý module mới xác nhận hoặc yêu cầu chỉnh sửa báo cáo của phòng. Viện trưởng duyệt hồ sơ trình.');

  function ghiLichSu(baoCaoId, hanhDong, nguoiId, ghiChu) {
    db.prepare('INSERT INTO bcp_lich_su (bao_cao_id, hanh_dong, nguoi_id, ghi_chu) VALUES (?,?,?,?)').run(
      baoCaoId,
      hanhDong,
      nguoiId,
      ghiChu || null
    );
  }

  const phienBanMoiNhat = (mauId) =>
    db
      .prepare('SELECT id, so_phien_ban, truong_json, created_at FROM bcp_mau_phien_ban WHERE mau_id = ? ORDER BY so_phien_ban DESC LIMIT 1')
      .get(mauId);

  // ── Tôi là ai ──────────────────────────────────────────────────────────────
  router.get(
    '/me',
    bao((req, res) => {
      const { laQuanLy, laQuanLyModule, laAdmin, laVienTruong, phongIds } = req.bcp;
      let phong = [];
      if (phongIds.length) {
        phong = db
          .prepare(`SELECT id, ma, ten FROM bcp_phong WHERE id IN (${phongIds.map(() => '?').join(',')}) ORDER BY ten`)
          .all(...phongIds);
      }
      res.json({
        quan_ly: laQuanLy,
        quan_ly_module: laQuanLyModule, // người xác nhận báo cáo từng phòng, tải/gửi hồ sơ (admin hoặc quan_ly), khác Viện trưởng
        la_admin: laAdmin,
        vien_truong: laVienTruong,
        phong,
        co_quyen: laQuanLy || phong.length > 0,
      });
    })
  );

  // ══ PHÒNG ══════════════════════════════════════════════════════════════════
  router.get(
    '/phong',
    canQuanLy,
    bao((req, res) => {
      const phong = db
        .prepare(
          `SELECT p.id, p.ma, p.ten, p.active,
                  (SELECT COUNT(*) FROM bcp_thanh_vien t WHERE t.phong_id = p.id) AS so_truong_phong
             FROM bcp_phong p ORDER BY p.active DESC, p.ten`
        )
        .all();
      res.json({ phong });
    })
  );

  // Phải đứng trước PUT /phong/:id (khác method nên không nuốt nhau, nhưng giữ đúng quy ước).
  router.post(
    '/phong/nhap-tu-don-vi',
    canQuanLy,
    bao((req, res) => {
      const co = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='units'").get();
      if (!co) return res.json({ them: 0, bo_qua: 0, ghi_chu: 'Chưa có danh mục đơn vị để nhập.' });
      const dv = db.prepare('SELECT code, name FROM units WHERE COALESCE(active,1) = 1').all();
      let them = 0;
      let boQua = 0;
      db.transaction(() => {
        for (const d of dv) {
          const ma = chuoi(d.code).toLowerCase();
          const ten = chuoi(d.name, 150);
          if (!ten) continue;
          const trung = db
            .prepare('SELECT 1 AS ok FROM bcp_phong WHERE ten = ? OR (ma IS NOT NULL AND ma = ?)')
            .get(ten, ma || null);
          if (trung) {
            boQua++;
            continue;
          }
          db.prepare('INSERT INTO bcp_phong (ma, ten) VALUES (?, ?)').run(MA_PHONG.test(ma) ? ma : null, ten);
          them++;
        }
      })();
      res.json({ them, bo_qua: boQua });
    })
  );

  router.post(
    '/phong',
    canQuanLy,
    bao((req, res) => {
      const ten = chuoi(req.body && req.body.ten, 150);
      if (!ten) return loi(res, 400, 'Cần nhập tên phòng.');
      const maRaw = chuoi(req.body && req.body.ma).toLowerCase();
      if (maRaw && !MA_PHONG.test(maRaw)) {
        return loi(res, 400, 'Mã phòng chỉ gồm chữ thường không dấu, số, gạch ngang/dưới (tối đa 30 ký tự).');
      }
      const ma = maRaw || null;
      if (db.prepare('SELECT 1 AS ok FROM bcp_phong WHERE ten = ? OR (ma IS NOT NULL AND ma = ?)').get(ten, ma)) {
        return loi(res, 409, 'Phòng này đã có (trùng tên hoặc mã).');
      }
      const r = db.prepare('INSERT INTO bcp_phong (ma, ten) VALUES (?, ?)').run(ma, ten);
      res.status(201).json({ id: Number(r.lastInsertRowid), ma, ten, active: 1 });
    })
  );

  router.put(
    '/phong/:id',
    canQuanLy,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const cu = db.prepare('SELECT id, ten, active FROM bcp_phong WHERE id = ?').get(id);
      if (!cu) return loi(res, 404, 'Không tìm thấy phòng.');
      const ten = req.body && req.body.ten !== undefined ? chuoi(req.body.ten, 150) : cu.ten;
      if (!ten) return loi(res, 400, 'Tên phòng không được để trống.');
      const active = req.body && typeof req.body.active === 'boolean' ? (req.body.active ? 1 : 0) : cu.active;
      if (ten !== cu.ten && db.prepare('SELECT 1 AS ok FROM bcp_phong WHERE ten = ? AND id <> ?').get(ten, id)) {
        return loi(res, 409, 'Đã có phòng khác trùng tên.');
      }
      db.prepare('UPDATE bcp_phong SET ten = ?, active = ? WHERE id = ?').run(ten, active, id);
      res.json({ id, ten, active });
    })
  );

  // ══ THÀNH VIÊN (phân quyền) ═══════════════════════════════════════════════
  router.get(
    '/nguoi-dung',
    canQuanLy,
    bao((req, res) => {
      const q = chuoi(req.query.q, 60);
      if (q.length < 2) return res.json({ nguoi_dung: [] });
      // Escape ký tự đại diện của LIKE để "%" hay "_" do người dùng gõ không khớp tất cả.
      const mau = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      const nguoi_dung = db
        .prepare(
          `SELECT id, fullname, email FROM users
            WHERE fullname LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
            ORDER BY fullname LIMIT 20`
        )
        .all(mau, mau);
      res.json({ nguoi_dung });
    })
  );

  router.get(
    '/thanh-vien',
    canQuanLy,
    bao((req, res) => {
      const thanh_vien = db
        .prepare(
          `SELECT t.id, t.vai_tro, t.phong_id, p.ten AS phong_ten, u.id AS user_id, u.fullname, u.email
             FROM bcp_thanh_vien t
             JOIN users u ON u.id = t.user_id
             LEFT JOIN bcp_phong p ON p.id = t.phong_id
            ORDER BY t.vai_tro, p.ten, u.fullname`
        )
        .all();
      res.json({ thanh_vien });
    })
  );

  router.post(
    '/thanh-vien',
    canQuanLy,
    bao((req, res) => {
      const b = req.body || {};
      const userId = docId(b.user_id);
      const vaiTro = b.vai_tro;
      if (!userId) return loi(res, 400, 'Cần chọn người dùng.');
      if (vaiTro !== 'quan_ly' && vaiTro !== 'vien_truong' && vaiTro !== 'truong_phong') return loi(res, 400, 'Vai trò không hợp lệ.');
      // Chỉ admin hệ thống được cấp quyền quản lý / Viện trưởng: người quản lý không tự nhân bản quyền
      // của mình, và không tự chỉ định ai là người duyệt hồ sơ trình.
      if (vaiTro !== 'truong_phong' && !req.bcp.laAdmin) {
        return loi(res, 403, 'Chỉ quản trị viên hệ thống mới cấp được vai trò quản lý module hoặc Viện trưởng.');
      }
      if (!db.prepare('SELECT 1 AS ok FROM users WHERE id = ?').get(userId)) return loi(res, 404, 'Không tìm thấy người dùng.');

      let phongId = null;
      if (vaiTro === 'truong_phong') {
        phongId = docId(b.phong_id);
        if (!phongId) return loi(res, 400, 'Cần chọn phòng cho trưởng phòng.');
        const p = db.prepare('SELECT id, active FROM bcp_phong WHERE id = ?').get(phongId);
        if (!p) return loi(res, 404, 'Không tìm thấy phòng.');
        if (!p.active) return loi(res, 409, 'Phòng này đang ngừng sử dụng.');
      }
      const trung = db
        .prepare('SELECT 1 AS ok FROM bcp_thanh_vien WHERE user_id = ? AND vai_tro = ? AND COALESCE(phong_id,0) = COALESCE(?,0)')
        .get(userId, vaiTro, phongId);
      if (trung) return loi(res, 409, 'Người này đã có vai trò đó.');

      const r = db
        .prepare('INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, created_by) VALUES (?,?,?,?)')
        .run(userId, vaiTro, phongId, req.user.id);
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    })
  );

  router.delete(
    '/thanh-vien/:id',
    canQuanLy,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const tv = db.prepare('SELECT id, vai_tro FROM bcp_thanh_vien WHERE id = ?').get(id);
      if (!tv) return loi(res, 404, 'Không tìm thấy.');
      if (tv.vai_tro !== 'truong_phong' && !req.bcp.laAdmin) {
        return loi(res, 403, 'Chỉ quản trị viên hệ thống mới gỡ được vai trò quản lý module hoặc Viện trưởng.');
      }
      db.prepare('DELETE FROM bcp_thanh_vien WHERE id = ?').run(id);
      res.json({ ok: true });
    })
  );

  // ══ BIỂU MẪU ═══════════════════════════════════════════════════════════════
  router.get(
    '/mau',
    canQuanLy,
    bao((req, res) => {
      const mau = db
        .prepare(
          `SELECT m.id, m.ten, m.mo_ta, m.created_at,
                  (SELECT MAX(so_phien_ban) FROM bcp_mau_phien_ban v WHERE v.mau_id = m.id) AS so_phien_ban,
                  (SELECT COUNT(*) FROM bcp_dot d JOIN bcp_mau_phien_ban v ON v.id = d.mau_phien_ban_id WHERE v.mau_id = m.id) AS so_dot
             FROM bcp_mau m ORDER BY m.id DESC`
        )
        .all();
      res.json({ mau });
    })
  );

  router.post(
    '/mau',
    canQuanLy,
    bao((req, res) => {
      const b = req.body || {};
      const ten = chuoi(b.ten, 150);
      if (!ten) return loi(res, 400, 'Cần nhập tên biểu mẫu.');
      const kq = chuanHoaMau(b.truong);
      if (!kq.ok) return loi(res, 400, kq.loi[0], { loi: kq.loi });

      let mauId;
      db.transaction(() => {
        const r = db
          .prepare('INSERT INTO bcp_mau (ten, mo_ta, created_by) VALUES (?,?,?)')
          .run(ten, chuoi(b.mo_ta, 1000) || null, req.user.id);
        mauId = Number(r.lastInsertRowid);
        db.prepare('INSERT INTO bcp_mau_phien_ban (mau_id, so_phien_ban, truong_json, created_by) VALUES (?,?,?,?)').run(
          mauId,
          1,
          JSON.stringify(kq.truong),
          req.user.id
        );
      })();
      res.status(201).json({ id: mauId, so_phien_ban: 1 });
    })
  );

  router.get(
    '/mau/:id',
    canQuanLy,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const m = db.prepare('SELECT id, ten, mo_ta FROM bcp_mau WHERE id = ?').get(id);
      if (!m) return loi(res, 404, 'Không tìm thấy biểu mẫu.');
      const pb = phienBanMoiNhat(id);
      res.json({
        ...m,
        so_phien_ban: pb.so_phien_ban,
        truong: parseJson(pb.truong_json, []),
      });
    })
  );

  /** Sửa biểu mẫu = tạo phiên bản MỚI. Các đợt đã giao vẫn dùng phiên bản đã ghim. */
  router.put(
    '/mau/:id',
    canQuanLy,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const m = db.prepare('SELECT id, ten, mo_ta FROM bcp_mau WHERE id = ?').get(id);
      if (!m) return loi(res, 404, 'Không tìm thấy biểu mẫu.');
      const b = req.body || {};
      const ten = b.ten !== undefined ? chuoi(b.ten, 150) : m.ten;
      if (!ten) return loi(res, 400, 'Tên biểu mẫu không được để trống.');
      const moTa = b.mo_ta !== undefined ? chuoi(b.mo_ta, 1000) || null : m.mo_ta;
      const kq = chuanHoaMau(b.truong);
      if (!kq.ok) return loi(res, 400, kq.loi[0], { loi: kq.loi });

      const moi = JSON.stringify(kq.truong);
      const hienTai = phienBanMoiNhat(id);
      let soPhienBan = hienTai.so_phien_ban;
      let daDoiCauTruc = false;
      db.transaction(() => {
        db.prepare('UPDATE bcp_mau SET ten = ?, mo_ta = ? WHERE id = ?').run(ten, moTa, id);
        // Không đổi cấu trúc thì không đẻ thêm phiên bản rỗng.
        if (moi !== hienTai.truong_json) {
          soPhienBan += 1;
          daDoiCauTruc = true;
          db.prepare('INSERT INTO bcp_mau_phien_ban (mau_id, so_phien_ban, truong_json, created_by) VALUES (?,?,?,?)').run(
            id,
            soPhienBan,
            moi,
            req.user.id
          );
        }
      })();
      res.json({ id, so_phien_ban: soPhienBan, da_doi_cau_truc: daDoiCauTruc });
    })
  );

  // ══ ĐỢT BÁO CÁO ════════════════════════════════════════════════════════════
  function kiemTraDot(b, { batBuocMau }) {
    const tieuDe = chuoi(b.tieu_de, 200);
    if (!tieuDe) return { loi: 'Cần nhập tiêu đề đợt báo cáo.' };
    const loai = b.loai === undefined ? 'thang' : b.loai;
    if (!LOAI_DOT.includes(loai)) return { loi: 'Loại đợt không hợp lệ.' };
    if (!ngayThat(b.han_nop)) return { loi: 'Hạn nộp không hợp lệ (định dạng AAAA-MM-DD).' };
    let phongIds = null;
    if (b.phong_ids !== undefined) {
      if (!Array.isArray(b.phong_ids)) return { loi: 'Danh sách phòng không hợp lệ.' };
      phongIds = [...new Set(b.phong_ids.map(docId))];
      if (phongIds.includes(null)) return { loi: 'Danh sách phòng chứa ID không hợp lệ.' };
      if (phongIds.length) {
        const co = db
          .prepare(`SELECT id FROM bcp_phong WHERE active = 1 AND id IN (${phongIds.map(() => '?').join(',')})`)
          .all(...phongIds);
        if (co.length !== phongIds.length) return { loi: 'Có phòng không tồn tại hoặc đã ngừng sử dụng.' };
      }
    }
    let mauId = null;
    if (b.mau_id !== undefined || batBuocMau) {
      mauId = docId(b.mau_id);
      if (!mauId || !db.prepare('SELECT 1 AS ok FROM bcp_mau WHERE id = ?').get(mauId)) return { loi: 'Cần chọn một biểu mẫu có thật.' };
    }
    return {
      gia_tri: {
        tieu_de: tieuDe,
        mo_ta: chuoi(b.mo_ta, 2000) || null,
        loai,
        ky: chuoi(b.ky, 50) || null,
        han_nop: b.han_nop,
        mau_id: mauId,
        phong_ids: phongIds,
      },
    };
  }

  router.get(
    '/dot',
    canQuanLy,
    bao((req, res) => {
      const homNay = ngayVN(new Date());
      const dots = db
        .prepare(
          `SELECT d.id, d.tieu_de, d.loai, d.ky, d.han_nop, d.trang_thai, d.created_at, m.ten AS mau_ten
             FROM bcp_dot d
             JOIN bcp_mau_phien_ban v ON v.id = d.mau_phien_ban_id
             JOIN bcp_mau m ON m.id = v.mau_id
            ORDER BY d.id DESC`
        )
        .all();
      const bcs = db.prepare('SELECT dot_id, trang_thai, nop_luc FROM bcp_bao_cao').all();
      const theoDot = new Map();
      for (const b of bcs) {
        if (!theoDot.has(b.dot_id)) theoDot.set(b.dot_id, []);
        theoDot.get(b.dot_id).push(b);
      }
      const ds = dots.map((d) => {
        const rows = theoDot.get(d.id) || [];
        const dem = { chua_nop: 0, da_nop: 0, can_chinh_sua: 0, da_duyet: 0 };
        let tre = 0;
        for (const r of rows) {
          dem[r.trang_thai] += 1;
          if (treHan(r, d, homNay)) tre += 1;
        }
        return { ...d, tong: rows.length, ...dem, tre_han: tre };
      });
      res.json({ dot: ds });
    })
  );

  router.post(
    '/dot',
    canQuanLy,
    bao((req, res) => {
      const kq = kiemTraDot(req.body || {}, { batBuocMau: true });
      if (kq.loi) return loi(res, 400, kq.loi);
      const g = kq.gia_tri;
      if (!g.phong_ids || g.phong_ids.length === 0) return loi(res, 400, 'Cần chọn ít nhất một phòng.');
      const pb = phienBanMoiNhat(g.mau_id);

      let dotId;
      db.transaction(() => {
        const r = db
          .prepare(
            'INSERT INTO bcp_dot (tieu_de, mo_ta, loai, ky, han_nop, mau_phien_ban_id, trang_thai, created_by) VALUES (?,?,?,?,?,?,?,?)'
          )
          .run(g.tieu_de, g.mo_ta, g.loai, g.ky, g.han_nop, pb.id, 'nhap', req.user.id);
        dotId = Number(r.lastInsertRowid);
        const ins = db.prepare('INSERT INTO bcp_bao_cao (dot_id, phong_id) VALUES (?, ?)');
        for (const pid of g.phong_ids) ins.run(dotId, pid);
      })();
      res.status(201).json({ id: dotId });
    })
  );

  router.get(
    '/dot/:id',
    canQuanLy,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const d = db
        .prepare(
          `SELECT d.*, v.so_phien_ban, v.truong_json, m.id AS mau_id, m.ten AS mau_ten
             FROM bcp_dot d
             JOIN bcp_mau_phien_ban v ON v.id = d.mau_phien_ban_id
             JOIN bcp_mau m ON m.id = v.mau_id
            WHERE d.id = ?`
        )
        .get(id);
      if (!d) return loi(res, 404, 'Không tìm thấy đợt báo cáo.');
      const homNay = ngayVN(new Date());
      const bao_cao = db
        .prepare(
          `SELECT b.id, b.phong_id, p.ten AS phong_ten, b.trang_thai, b.nop_luc, b.duyet_luc, b.cap_nhat_luc,
                  un.fullname AS nguoi_nop,
                  (b.trang_thai = 'da_duyet' AND b.nguoi_nop_id IS NOT NULL AND b.nguoi_nop_id = b.nguoi_duyet_id) AS tu_duyet
             FROM bcp_bao_cao b
             JOIN bcp_phong p ON p.id = b.phong_id
             LEFT JOIN users un ON un.id = b.nguoi_nop_id
            WHERE b.dot_id = ? ORDER BY p.ten`
        )
        .all(id)
        .map((b) => ({ ...b, tre_han: treHan(b, d, homNay) }));
      const { truong_json, ...dot } = d;
      res.json({ dot, truong: parseJson(truong_json, []), bao_cao });
    })
  );

  router.put(
    '/dot/:id',
    canQuanLy,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const cu = db.prepare('SELECT id, trang_thai, tieu_de, mo_ta, han_nop FROM bcp_dot WHERE id = ?').get(id);
      if (!cu) return loi(res, 404, 'Không tìm thấy đợt báo cáo.');
      const kq = kiemTraDot(req.body || {}, { batBuocMau: false });
      if (kq.loi) return loi(res, 400, kq.loi);
      const g = kq.gia_tri;

      if (g.mau_id && cu.trang_thai !== 'nhap') {
        return loi(res, 409, 'Chỉ đổi được biểu mẫu khi đợt còn ở trạng thái Nháp.');
      }

      // Những thay đổi người ta SẼ thấy: hạn nộp, tiêu đề, hướng dẫn. Đợt Nháp chưa ai thấy nên không tính.
      const thayDoi = [];
      if (cu.trang_thai !== 'nhap') {
        if (cu.han_nop !== g.han_nop) thayDoi.push({ khoa: 'han_nop', cu: cu.han_nop, moi: g.han_nop });
        if (cu.tieu_de !== g.tieu_de) thayDoi.push({ khoa: 'tieu_de', cu: cu.tieu_de, moi: g.tieu_de });
        if ((cu.mo_ta || null) !== g.mo_ta) thayDoi.push({ khoa: 'mo_ta', cu: cu.mo_ta, moi: g.mo_ta });
      }
      // Chỉ báo khi đợt ĐANG MỞ (đợt đã đóng thì hạn nộp không còn ý nghĩa). Người quản lý có thể tắt.
      const khongBao = req.body && req.body.khong_thong_bao === true;
      const seBao = cu.trang_thai === 'dang_mo' && thayDoi.length > 0 && !khongBao;

      let hienCo = [];
      if (g.phong_ids) {
        hienCo = db.prepare('SELECT phong_id FROM bcp_bao_cao WHERE dot_id = ?').all(id).map((r) => r.phong_id);
        const boBot = hienCo.filter((p) => !g.phong_ids.includes(p));
        // Gỡ phòng khỏi đợt đã mở sẽ làm mất báo cáo họ có thể đã nhập, nên chỉ cho khi còn Nháp.
        if (boBot.length && cu.trang_thai !== 'nhap') {
          return loi(res, 409, 'Đợt đã mở: chỉ được thêm phòng, không gỡ phòng.');
        }
        if (g.phong_ids.length === 0) return loi(res, 400, 'Cần chọn ít nhất một phòng.');
      }

      db.transaction(() => {
        db.prepare('UPDATE bcp_dot SET tieu_de=?, mo_ta=?, loai=?, ky=?, han_nop=? WHERE id=?').run(
          g.tieu_de,
          g.mo_ta,
          g.loai,
          g.ky,
          g.han_nop,
          id
        );
        if (g.mau_id) {
          db.prepare('UPDATE bcp_dot SET mau_phien_ban_id = ? WHERE id = ?').run(phienBanMoiNhat(g.mau_id).id, id);
        }
        if (g.phong_ids) {
          const ins = db.prepare('INSERT INTO bcp_bao_cao (dot_id, phong_id) VALUES (?, ?)');
          for (const pid of g.phong_ids) if (!hienCo.includes(pid)) ins.run(id, pid);
          for (const pid of hienCo) {
            if (!g.phong_ids.includes(pid)) db.prepare('DELETE FROM bcp_bao_cao WHERE dot_id = ? AND phong_id = ?').run(id, pid);
          }
        }
        if (thayDoi.length) {
          const ngay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s.split('-').reverse().join('/') : s);
          const tom = thayDoi
            .map((x) => (x.khoa === 'han_nop' ? `Hạn nộp ${ngay(x.cu)} → ${ngay(x.moi)}` : x.khoa === 'tieu_de' ? `Tiêu đề «${x.cu}» → «${x.moi}»` : 'Hướng dẫn đã sửa'))
            .join('; ');
          db.prepare('INSERT INTO bcp_dot_lich_su (dot_id, hanh_dong, nguoi_id, ghi_chu) VALUES (?,?,?,?)').run(
            id, 'sua_dot', req.user.id, tom + (cu.trang_thai === 'dang_mo' ? (khongBao ? ' (không gửi thông báo)' : '') : '')
          );
        }
      })();
      // Thêm phòng vào đợt ĐÃ mở: báo riêng trưởng phòng của các phòng mới thêm (đợt Nháp thì chưa ai thấy).
      if (cu.trang_thai === 'dang_mo' && g.phong_ids) {
        const moiThem = g.phong_ids.filter((p) => !hienCo.includes(p));
        if (moiThem.length) guiNen(thongBao.baoMoDot(id, moiThem));
      }
      // Số người sẽ nhận thư (đếm đồng bộ để giao diện báo lại; việc gửi vẫn chạy nền, không chặn thao tác).
      let daBao = 0;
      if (seBao) {
        daBao = thongBao.nguoiNhanSuaDot(id, req.user.id).length;
        guiNen(thongBao.baoSuaDot(id, thayDoi, req.user.id));
      }
      res.json({ id, da_bao: daBao });
    })
  );

  /** Đổi trạng thái đợt, chỉ cho phép từ các trạng thái hợp lệ (so sánh ngay trong UPDATE). */
  function chuyenTrangThaiDot(tu, den, thongBaoSai) {
    return bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const d = db.prepare('SELECT id FROM bcp_dot WHERE id = ?').get(id);
      if (!d) return loi(res, 404, 'Không tìm thấy đợt báo cáo.');
      if (den === 'dang_mo' && tu === 'nhap') {
        const so = db.prepare('SELECT COUNT(*) AS n FROM bcp_bao_cao WHERE dot_id = ?').get(id).n;
        if (so === 0) return loi(res, 409, 'Đợt chưa giao cho phòng nào.');
      }
      const r = db.prepare('UPDATE bcp_dot SET trang_thai = ? WHERE id = ? AND trang_thai = ?').run(den, id, tu);
      if (r.changes === 0) return loi(res, 409, thongBaoSai);
      // Chỉ lần MỞ đầu tiên (Nháp → Đang mở) mới báo trưởng phòng; mở lại đợt đã đóng thì không gửi lại.
      if (tu === 'nhap' && den === 'dang_mo') guiNen(thongBao.baoMoDot(id));
      res.json({ id, trang_thai: den });
    });
  }
  router.post('/dot/:id/mo', canQuanLy, chuyenTrangThaiDot('nhap', 'dang_mo', 'Chỉ mở được đợt đang ở trạng thái Nháp.'));
  router.post('/dot/:id/dong', canQuanLy, chuyenTrangThaiDot('dang_mo', 'dong', 'Chỉ đóng được đợt đang mở.'));
  router.post('/dot/:id/mo-lai', canQuanLy, chuyenTrangThaiDot('dong', 'dang_mo', 'Chỉ mở lại được đợt đã đóng.'));

  router.delete(
    '/dot/:id',
    canQuanLy,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const r = db.prepare("DELETE FROM bcp_dot WHERE id = ? AND trang_thai = 'nhap'").run(id);
      if (r.changes === 0) {
        const co = db.prepare('SELECT 1 AS ok FROM bcp_dot WHERE id = ?').get(id);
        return co ? loi(res, 409, 'Chỉ xóa được đợt còn ở trạng thái Nháp.') : loi(res, 404, 'Không tìm thấy đợt báo cáo.');
      }
      res.json({ ok: true });
    })
  );

  // ══ BÁO CÁO ════════════════════════════════════════════════════════════════
  router.get(
    '/cua-toi',
    bao((req, res) => {
      const { phongIds } = req.bcp;
      if (!phongIds.length) return res.json({ bao_cao: [] });
      const homNay = ngayVN(new Date());
      const rows = db
        .prepare(
          `SELECT b.id, b.trang_thai, b.nop_luc, b.nhan_xet, b.phong_id, p.ten AS phong_ten,
                  d.id AS dot_id, d.tieu_de, d.loai, d.ky, d.han_nop, d.trang_thai AS dot_trang_thai
             FROM bcp_bao_cao b
             JOIN bcp_dot d ON d.id = b.dot_id
             JOIN bcp_phong p ON p.id = b.phong_id
            WHERE b.phong_id IN (${phongIds.map(() => '?').join(',')})
              AND d.trang_thai IN ('dang_mo','dong')
            ORDER BY d.han_nop DESC, d.id DESC`
        )
        .all(...phongIds);
      res.json({
        bao_cao: rows.map((r) => ({
          ...r,
          tre_han: treHan(r, { han_nop: r.han_nop, trang_thai: r.dot_trang_thai }, homNay),
          sua_duoc: r.dot_trang_thai === 'dang_mo' && TRANG_THAI_SUA_DUOC.includes(r.trang_thai),
        })),
      });
    })
  );

  /** Hồ sơ trình đang chờ Viện trưởng duyệt, kèm người gửi, lời nhắn và tên tệp để thẻ việc hiện đủ không cần bấm thêm. */
  function hoSoChoVienTruong() {
    const ds = db
      .prepare(
        `SELECT t.dot_id, d.tieu_de, t.gui_luc, t.loi_nhan, u.fullname AS nguoi_gui
           FROM bcp_trinh t JOIN bcp_dot d ON d.id = t.dot_id LEFT JOIN users u ON u.id = t.nguoi_gui_id
          WHERE t.trang_thai = 'da_gui' ORDER BY t.gui_luc`
      )
      .all();
    const tep = db.prepare('SELECT id, ten_goc FROM bcp_trinh_tep WHERE dot_id = ? ORDER BY id');
    return ds.map((x) => ({ ...x, tep: tep.all(x.dot_id) }));
  }

  /**
   * "Việc của tôi" cho MỌI người có vai trò, nhẹ để trang chủ gọi được: báo cáo của phòng mình đang cần nộp/chỉnh sửa
   * (trưởng phòng) và hồ sơ đang chờ mình duyệt (CHỈ Viện trưởng; người khác luôn nhận danh sách rỗng).
   */
  router.get(
    '/viec-cua-toi',
    bao((req, res) => {
      const { phongIds, laVienTruong } = req.bcp;
      const homNay = ngayVN(new Date());
      let baoCao = [];
      if (phongIds.length) {
        baoCao = db
          .prepare(
            `SELECT b.id, b.trang_thai, b.nop_luc, p.ten AS phong_ten, d.id AS dot_id, d.tieu_de, d.han_nop, d.trang_thai AS dot_trang_thai
               FROM bcp_bao_cao b JOIN bcp_dot d ON d.id = b.dot_id JOIN bcp_phong p ON p.id = b.phong_id
              WHERE b.phong_id IN (${phongIds.map(() => '?').join(',')})
                AND d.trang_thai = 'dang_mo' AND b.trang_thai IN ('chua_nop','can_chinh_sua')
              ORDER BY d.han_nop, d.id`
          )
          .all(...phongIds)
          .map((r) => ({
            id: r.id, trang_thai: r.trang_thai, phong_ten: r.phong_ten, tieu_de: r.tieu_de, han_nop: r.han_nop,
            tre_han: treHan(r, { han_nop: r.han_nop, trang_thai: r.dot_trang_thai }, homNay),
          }));
      }
      res.json({ bao_cao: baoCao, ho_so_duyet: laVienTruong ? hoSoChoVienTruong() : [] });
    })
  );

  /** Nạp báo cáo + đợt + biểu mẫu đã ghim, hoặc null nếu người gọi không có quyền thấy. */
  function nap(req, id) {
    const b = db
      .prepare(
        `SELECT b.*, p.ten AS phong_ten,
                d.tieu_de, d.mo_ta AS dot_mo_ta, d.loai, d.ky, d.han_nop, d.trang_thai AS dot_trang_thai,
                v.so_phien_ban, v.truong_json
           FROM bcp_bao_cao b
           JOIN bcp_phong p ON p.id = b.phong_id
           JOIN bcp_dot d ON d.id = b.dot_id
           JOIN bcp_mau_phien_ban v ON v.id = d.mau_phien_ban_id
          WHERE b.id = ?`
      )
      .get(id);
    if (!b) return null;
    const laChuPhong = req.bcp.phongIds.includes(b.phong_id) && b.dot_trang_thai !== 'nhap';
    if (!req.bcp.laQuanLy && !laChuPhong) return null; // không phân biệt "không có" và "không được xem"
    return { b, laChuPhong };
  }

  router.get(
    '/bao-cao/:id',
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const n = nap(req, id);
      if (!n) return loi(res, 404, 'Không tìm thấy báo cáo.');
      const { b, laChuPhong } = n;
      const homNay = ngayVN(new Date());
      const nguoiNopDuyet = db
        .prepare(
          `SELECT un.fullname AS nguoi_nop, ud.fullname AS nguoi_duyet
             FROM bcp_bao_cao b
             LEFT JOIN users un ON un.id = b.nguoi_nop_id
             LEFT JOIN users ud ON ud.id = b.nguoi_duyet_id
            WHERE b.id = ?`
        )
        .get(id);
      // "Tự duyệt" suy ra từ dữ liệu (không lưu cờ riêng): báo cáo đang Đã duyệt mà người nộp chính là người duyệt.
      const tuDuyet = b.trang_thai === 'da_duyet' && b.nguoi_nop_id != null && b.nguoi_nop_id === b.nguoi_duyet_id;
      const lich_su = db
        .prepare(
          `SELECT h.hanh_dong, h.ghi_chu, h.tao_luc, u.fullname AS nguoi
             FROM bcp_lich_su h LEFT JOIN users u ON u.id = h.nguoi_id
            WHERE h.bao_cao_id = ? ORDER BY h.id`
        )
        .all(id);
      res.json({
        id: b.id,
        phong_id: b.phong_id,
        phong_ten: b.phong_ten,
        trang_thai: b.trang_thai,
        nhan_xet: b.nhan_xet,
        nop_luc: b.nop_luc,
        duyet_luc: b.duyet_luc,
        nguoi_nop: nguoiNopDuyet.nguoi_nop,
        nguoi_duyet: b.trang_thai === 'da_duyet' ? nguoiNopDuyet.nguoi_duyet : null,
        tu_duyet: tuDuyet,
        nop_boi_toi: b.nguoi_nop_id != null && b.nguoi_nop_id === req.user.id,
        tre_han: treHan(b, { han_nop: b.han_nop, trang_thai: b.dot_trang_thai }, homNay),
        dot: {
          id: b.dot_id,
          tieu_de: b.tieu_de,
          mo_ta: b.dot_mo_ta,
          loai: b.loai,
          ky: b.ky,
          han_nop: b.han_nop,
          trang_thai: b.dot_trang_thai,
        },
        truong: parseJson(b.truong_json, []),
        du_lieu: parseJson(b.du_lieu_json, {}),
        lich_su,
        // Cờ cho giao diện; server vẫn kiểm lại ở từng thao tác.
        sua_duoc: laChuPhong && b.dot_trang_thai === 'dang_mo' && TRANG_THAI_SUA_DUOC.includes(b.trang_thai),
        duyet_duoc: req.bcp.laQuanLyModule && b.trang_thai === 'da_nop',
        yeu_cau_sua_duoc:
          req.bcp.laQuanLyModule && b.dot_trang_thai === 'dang_mo' && (b.trang_thai === 'da_nop' || b.trang_thai === 'da_duyet'),
      });
    })
  );

  /** Chỉ chủ phòng được nhập. Người quản lý xem và duyệt, KHÔNG nhập hộ (tránh nhầm "ai khai"). */
  function napDeNhap(req, res) {
    const id = docId(req.params.id);
    if (!id) {
      loi(res, 400, 'ID không hợp lệ.');
      return null;
    }
    const n = nap(req, id);
    if (!n || !n.laChuPhong) {
      loi(res, 404, 'Không tìm thấy báo cáo.');
      return null;
    }
    if (n.b.dot_trang_thai !== 'dang_mo') {
      loi(res, 409, n.b.dot_trang_thai === 'dong' ? 'Đợt báo cáo đã đóng.' : 'Đợt báo cáo chưa mở.');
      return null;
    }
    if (!TRANG_THAI_SUA_DUOC.includes(n.b.trang_thai)) {
      loi(res, 409, n.b.trang_thai === 'da_duyet' ? 'Báo cáo đã được xác nhận.' : 'Báo cáo đã nộp, đang chờ xác nhận.');
      return null;
    }
    return n.b;
  }

  router.put(
    '/bao-cao/:id/du-lieu',
    bao((req, res) => {
      const b = napDeNhap(req, res);
      if (!b) return;
      const truong = parseJson(b.truong_json, []);
      const kq = kiemTraDuLieu(truong, req.body && req.body.du_lieu, { nop: false });
      if (!kq.ok) return loi(res, 422, 'Dữ liệu có ô không hợp lệ.', { loi: kq.loi });
      const r = db
        .prepare(
          `UPDATE bcp_bao_cao SET du_lieu_json = ?, cap_nhat_luc = datetime('now')
            WHERE id = ? AND trang_thai IN ('chua_nop','can_chinh_sua')`
        )
        .run(JSON.stringify(kq.du_lieu), b.id);
      if (r.changes === 0) return loi(res, 409, 'Báo cáo vừa đổi trạng thái, hãy tải lại trang.');
      res.json({ ok: true });
    })
  );

  router.post(
    '/bao-cao/:id/nop',
    bao((req, res) => {
      const b = napDeNhap(req, res);
      if (!b) return;
      const truong = parseJson(b.truong_json, []);
      // Nếu client gửi kèm dữ liệu thì nộp đúng bản đó; không thì nộp bản đã lưu nháp.
      const nguon = req.body && req.body.du_lieu !== undefined ? req.body.du_lieu : parseJson(b.du_lieu_json, {});
      const kq = kiemTraDuLieu(truong, nguon, { nop: true });
      if (!kq.ok) return loi(res, 422, 'Chưa điền đủ hoặc có ô không hợp lệ.', { loi: kq.loi });

      let doi = 0;
      db.transaction(() => {
        const r = db
          .prepare(
            `UPDATE bcp_bao_cao
                SET du_lieu_json = ?, trang_thai = 'da_nop', nguoi_nop_id = ?, nop_luc = ?,
                    nhan_xet = NULL, cap_nhat_luc = datetime('now')
              WHERE id = ? AND trang_thai IN ('chua_nop','can_chinh_sua')`
          )
          .run(JSON.stringify(kq.du_lieu), req.user.id, new Date().toISOString(), b.id);
        doi = r.changes;
        if (doi) ghiLichSu(b.id, b.trang_thai === 'can_chinh_sua' ? 'nop_lai' : 'nop', req.user.id, null);
      })();
      if (!doi) return loi(res, 409, 'Báo cáo vừa đổi trạng thái, hãy tải lại trang.');
      guiNen(thongBao.baoDaNop(b.id, req.user.id, b.trang_thai === 'can_chinh_sua'));
      res.json({ ok: true, trang_thai: 'da_nop' });
    })
  );

  router.post(
    '/bao-cao/:id/duyet',
    canXacNhan,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const n = nap(req, id);
      if (!n) return loi(res, 404, 'Không tìm thấy báo cáo.');
      const nhanXet = chuoi(req.body && req.body.nhan_xet, 2000) || null;
      let doi = 0;
      let tuDuyet = false;
      db.transaction(() => {
        // Điều kiện trạng thái nằm ngay trong UPDATE: hai người duyệt cùng lúc thì chỉ một người thắng.
        const r = db
          .prepare(
            `UPDATE bcp_bao_cao SET trang_thai = 'da_duyet', nguoi_duyet_id = ?, duyet_luc = ?, nhan_xet = ?
              WHERE id = ? AND trang_thai = 'da_nop'`
          )
          .run(req.user.id, new Date().toISOString(), nhanXet, id);
        doi = r.changes;
        if (doi) {
          // Chính sách: người nộp ĐƯỢC tự duyệt (vd. trưởng phòng TCHC vừa quản lý module vừa viết báo cáo
          // phòng mình), nhưng phải ghi rõ để người xem biết. Hành động riêng 'tu_duyet', không lẫn với 'duyet'.
          const nop = db.prepare('SELECT nguoi_nop_id FROM bcp_bao_cao WHERE id = ?').get(id);
          tuDuyet = nop.nguoi_nop_id != null && nop.nguoi_nop_id === req.user.id;
          ghiLichSu(id, tuDuyet ? 'tu_duyet' : 'duyet', req.user.id, nhanXet);
        }
      })();
      if (!doi) return loi(res, 409, 'Chỉ xác nhận được báo cáo đang ở trạng thái Đã nộp.');
      res.json({ ok: true, trang_thai: 'da_duyet', tu_duyet: tuDuyet });
    })
  );

  router.post(
    '/bao-cao/:id/yeu-cau-chinh-sua',
    canXacNhan,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const n = nap(req, id);
      if (!n) return loi(res, 404, 'Không tìm thấy báo cáo.');
      const nhanXet = chuoi(req.body && req.body.nhan_xet, 2000);
      if (!nhanXet) return loi(res, 400, 'Cần ghi rõ nội dung cần chỉnh sửa.');
      if (n.b.dot_trang_thai !== 'dang_mo') {
        return loi(res, 409, 'Đợt đã đóng. Hãy mở lại đợt trước khi yêu cầu chỉnh sửa.');
      }
      let doi = 0;
      db.transaction(() => {
        const r = db
          .prepare(
            `UPDATE bcp_bao_cao SET trang_thai = 'can_chinh_sua', nhan_xet = ?, nguoi_duyet_id = ?, duyet_luc = NULL
              WHERE id = ? AND trang_thai IN ('da_nop','da_duyet')`
          )
          .run(nhanXet, req.user.id, id);
        doi = r.changes;
        if (doi) ghiLichSu(id, 'yeu_cau_chinh_sua', req.user.id, nhanXet);
      })();
      if (!doi) return loi(res, 409, 'Chỉ yêu cầu chỉnh sửa được báo cáo đã nộp hoặc đã xác nhận.');
      res.json({ ok: true, trang_thai: 'can_chinh_sua' });
    })
  );


  // ══ LỜI MỜI TRƯỞNG PHÒNG QUA EMAIL ═══════════════════════════════════════════
  // Người quản lý nhập email. Đã có tài khoản eoffice → gán luôn (và báo cho họ). CHƯA có → tạo lời mời
  // chờ + gửi thư hướng dẫn đăng ký kèm MÃ DÙNG MỘT LẦN.
  //
  // Vì sao phải có mã, không tự gắn quyền cho "bất kỳ ai đăng ký email đó": đăng ký tài khoản của hệ
  // thống KHÔNG xác minh quyền sở hữu email (ai gõ ten@sci.edu.vn cũng đăng ký và đăng nhập được ngay).
  // Nếu tự gắn, kẻ đăng ký trước sẽ chiếm quyền. Mã gửi tới CHÍNH hộp thư được mời nên chỉ người đọc được
  // hộp thư đó mới nhận được quyền — và vẫn phải đăng nhập bằng đúng email đó. Mã lưu dạng BĂM.
  // Chỉ mời được vai trò TRƯỞNG PHÒNG (quyền thấp nhất, một phòng): quản lý/Viện trưởng chỉ gán cho người
  // đã có tài khoản, vì danh tính chưa xác minh thì không nên trao quyền xem toàn bộ.
  const MIEN_EMAIL = '@sci.edu.vn'; // khớp ALLOWED_EMAIL_DOMAIN của /api/register trong server.js
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const HAN_LOI_MOI_MS = 14 * 24 * 3600 * 1000;
  const bamMa = (ma) => crypto.createHash('sha256').update(String(ma)).digest('hex');
  const taoMa = () => crypto.randomBytes(16).toString('hex'); // 128 bit

  router.post(
    '/loi-moi',
    canQuanLy,
    bao((req, res) => {
      const b = req.body || {};
      const email = chuoi(b.email, 200).toLowerCase();
      if (!EMAIL_RE.test(email)) return loi(res, 400, 'Email không hợp lệ.');
      if (!email.endsWith(MIEN_EMAIL)) {
        return loi(res, 400, 'Chỉ mời được email có đuôi ' + MIEN_EMAIL + ' (cùng điều kiện với đăng ký tài khoản eoffice).');
      }
      const phongId = docId(b.phong_id);
      if (!phongId) return loi(res, 400, 'Cần chọn phòng.');
      const p = db.prepare('SELECT id, ten, active FROM bcp_phong WHERE id = ?').get(phongId);
      if (!p) return loi(res, 404, 'Không tìm thấy phòng.');
      if (!p.active) return loi(res, 409, 'Phòng này đang ngừng sử dụng.');

      const user = db.prepare('SELECT id, fullname FROM users WHERE lower(email) = ?').get(email);
      if (user) {
        const trung = db.prepare("SELECT 1 AS ok FROM bcp_thanh_vien WHERE user_id = ? AND vai_tro = 'truong_phong' AND phong_id = ?").get(user.id, phongId);
        if (trung) return loi(res, 409, 'Người này đã là trưởng phòng của phòng này.');
        db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, created_by) VALUES (?, 'truong_phong', ?, ?)").run(user.id, phongId, req.user.id);
        guiNen(thongBao.baoDuocGan(user.id, phongId, req.user.id));
        return res.status(201).json({ ket_qua: 'da_gan', user_id: user.id, fullname: user.fullname });
      }

      if (db.prepare("SELECT 1 AS ok FROM bcp_loi_moi WHERE email = ? AND phong_id = ? AND trang_thai = 'cho'").get(email, phongId)) {
        return loi(res, 409, 'Đã gửi lời mời cho email này và đang chờ. Dùng "Gửi lại" nếu người đó chưa nhận được thư.');
      }
      const ma = taoMa();
      const hetHan = new Date(Date.now() + HAN_LOI_MOI_MS).toISOString();
      const r = db
        .prepare('INSERT INTO bcp_loi_moi (email, phong_id, ma_bam, nguoi_moi_id, het_han) VALUES (?,?,?,?,?)')
        .run(email, phongId, bamMa(ma), req.user.id, hetHan);
      guiNen(thongBao.baoLoiMoi({ email, phongTen: p.ten, nguoiMoiTen: req.user.fullname, ma, hetHan }));
      res.status(201).json({ ket_qua: 'da_moi', id: Number(r.lastInsertRowid), het_han: hetHan });
    })
  );

  router.get(
    '/loi-moi',
    canQuanLy,
    bao((req, res) => {
      const ds = db
        .prepare(
          `SELECT l.id, l.email, l.phong_id, p.ten AS phong_ten, l.tao_luc, l.het_han, u.fullname AS nguoi_moi
             FROM bcp_loi_moi l JOIN bcp_phong p ON p.id = l.phong_id LEFT JOIN users u ON u.id = l.nguoi_moi_id
            WHERE l.trang_thai = 'cho' ORDER BY l.id DESC`
        )
        .all();
      const bay = Date.now();
      // KHÔNG bao giờ trả mã hay mã băm ra ngoài.
      res.json({ loi_moi: ds.map((l) => ({ ...l, het_han_roi: Date.parse(l.het_han) < bay })) });
    })
  );

  // Phải đứng trước các đường có :id.
  router.post(
    '/loi-moi/nhan',
    bao((req, res) => {
      const ma = chuoi(req.body && req.body.ma, 100).replace(/\s+/g, '').toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(ma)) return loi(res, 400, 'Mã lời mời không hợp lệ (gồm 32 ký tự chữ và số trong email).');
      const l = db.prepare('SELECT * FROM bcp_loi_moi WHERE ma_bam = ?').get(bamMa(ma));
      // Một thông báo chung cho mã sai / đã dùng / hết hạn / đã hủy: không để kẻ đoán mã phân biệt được.
      if (!l || l.trang_thai !== 'cho' || Date.parse(l.het_han) < Date.now()) {
        return loi(res, 400, 'Mã lời mời không đúng, đã được dùng hoặc đã hết hạn.');
      }
      // Có mã VẪN chưa đủ: phải đang đăng nhập bằng đúng email được mời.
      if (String(req.user.email || '').toLowerCase() !== l.email) {
        return loi(res, 403, 'Lời mời này dành cho một địa chỉ email khác. Hãy đăng nhập bằng đúng email đã nhận thư mời.');
      }
      const p = db.prepare('SELECT id, ten, active FROM bcp_phong WHERE id = ?').get(l.phong_id);
      if (!p || !p.active) return loi(res, 409, 'Phòng này không còn dùng được. Hãy liên hệ người quản lý module.');
      db.transaction(() => {
        const co = db.prepare("SELECT 1 AS ok FROM bcp_thanh_vien WHERE user_id = ? AND vai_tro = 'truong_phong' AND phong_id = ?").get(req.user.id, l.phong_id);
        if (!co) {
          db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, created_by) VALUES (?, 'truong_phong', ?, ?)").run(req.user.id, l.phong_id, l.nguoi_moi_id);
        }
        db.prepare("UPDATE bcp_loi_moi SET trang_thai = 'da_nhan', nhan_luc = ?, nguoi_nhan_id = ? WHERE id = ? AND trang_thai = 'cho'").run(new Date().toISOString(), req.user.id, l.id);
      })();
      res.json({ ok: true, phong: { id: p.id, ten: p.ten } });
    })
  );

  router.post(
    '/loi-moi/:id/gui-lai',
    canQuanLy,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const l = db.prepare("SELECT l.id, l.email, p.ten AS phong_ten FROM bcp_loi_moi l JOIN bcp_phong p ON p.id = l.phong_id WHERE l.id = ? AND l.trang_thai = 'cho'").get(id);
      if (!l) return loi(res, 404, 'Không tìm thấy lời mời đang chờ.');
      // Mã CŨ mất hiệu lực (ma_bam bị thay): thư gửi nhầm/cũ không dùng được nữa.
      const ma = taoMa();
      const hetHan = new Date(Date.now() + HAN_LOI_MOI_MS).toISOString();
      db.prepare('UPDATE bcp_loi_moi SET ma_bam = ?, het_han = ?, nguoi_moi_id = ? WHERE id = ?').run(bamMa(ma), hetHan, req.user.id, id);
      guiNen(thongBao.baoLoiMoi({ email: l.email, phongTen: l.phong_ten, nguoiMoiTen: req.user.fullname, ma, hetHan }));
      res.json({ ok: true, het_han: hetHan });
    })
  );

  router.delete(
    '/loi-moi/:id',
    canQuanLy,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const r = db.prepare("UPDATE bcp_loi_moi SET trang_thai = 'huy' WHERE id = ? AND trang_thai = 'cho'").run(id);
      if (r.changes === 0) return loi(res, 404, 'Không tìm thấy lời mời đang chờ.');
      res.json({ ok: true });
    })
  );

  // ══ TỔNG QUAN — "đang cần tôi làm gì" ═══════════════════════════════════════
  // Một chỗ duy nhất trả lời: bao nhiêu phòng đã nộp / cần nộp, ở đợt nào, bao nhiêu báo cáo đang
  // chờ duyệt, bao nhiêu hồ sơ đang chờ Viện trưởng. Giao diện dùng nó cho dải "Cần xử lý" và số đếm
  // trên thanh điều hướng. Email báo nộp (services/baoCaoPhongThongBao.js) dùng cùng cách tính tiến độ.
  router.get(
    '/tong-quan',
    canQuanLy,
    bao((req, res) => {
      const homNay = ngayVN(new Date());
      const dots = db.prepare("SELECT id, tieu_de, ky, han_nop, trang_thai FROM bcp_dot WHERE trang_thai = 'dang_mo' ORDER BY han_nop, id").all();
      const bcs = db
        .prepare("SELECT b.dot_id, b.trang_thai, b.nop_luc FROM bcp_bao_cao b JOIN bcp_dot d ON d.id = b.dot_id WHERE d.trang_thai = 'dang_mo'")
        .all();
      const theoDot = new Map();
      for (const b of bcs) {
        if (!theoDot.has(b.dot_id)) theoDot.set(b.dot_id, []);
        theoDot.get(b.dot_id).push(b);
      }
      let chuaNopTong = 0;
      let treTong = 0;
      const chiTiet = dots.map((d) => {
        const rows = theoDot.get(d.id) || [];
        const dem = { tong: rows.length, da_nop: 0, cho_duyet: 0, chua_nop: 0, tre_han: 0 };
        for (const r of rows) {
          if (r.trang_thai === 'da_nop' || r.trang_thai === 'da_duyet') dem.da_nop++;
          if (r.trang_thai === 'da_nop') dem.cho_duyet++;
          if (r.trang_thai === 'chua_nop' || r.trang_thai === 'can_chinh_sua') dem.chua_nop++;
          if (treHan(r, d, homNay)) dem.tre_han++;
        }
        chuaNopTong += dem.chua_nop;
        treTong += dem.tre_han;
        return { dot_id: d.id, tieu_de: d.tieu_de, ky: d.ky, han_nop: d.han_nop, ...dem };
      });
      // Báo cáo chờ duyệt: tính cả đợt đã đóng (đóng đợt không có nghĩa là đã duyệt xong).
      const choDuyet = db
        .prepare("SELECT COUNT(*) AS n FROM bcp_bao_cao b JOIN bcp_dot d ON d.id = b.dot_id WHERE b.trang_thai = 'da_nop' AND d.trang_thai IN ('dang_mo','dong')")
        .get().n;
      const choVienTruong = hoSoChoVienTruong();
      res.json({
        la_vien_truong: req.bcp.laVienTruong,
        dot_dang_mo: dots.length,
        cho_duyet: choDuyet,
        chua_nop: chuaNopTong,
        tre_han: treTong,
        cho_vien_truong: choVienTruong.length,
        ho_so_cho_vien_truong: choVienTruong,
        chi_tiet: chiTiet,
      });
    })
  );

  // ══ KẾT XUẤT WORD / PDF ═════════════════════════════════════════════════════
  // GET /dot/:id/xuat?phong=3,5,7&dinh_dang=docx|pdf     (phong=tat-ca: mọi phòng ĐÃ NỘP của đợt)
  // Chỉ xuất báo cáo ĐÃ NỘP hoặc ĐÃ DUYỆT: bản nháp hay "cần chỉnh sửa" chưa phải số liệu chốt, đưa
  // vào hồ sơ trình Viện trưởng là sai. Nếu người quản lý chọn đích danh một phòng chưa nộp thì báo
  // lỗi rõ tên phòng đó, KHÔNG lặng lẽ bỏ qua (tránh tưởng file đã đủ mà thiếu).
  const MIME_XUAT = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pdf: 'application/pdf',
  };
  router.get(
    '/dot/:id/xuat',
    canQuanLy,
    bao(async (req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const dd = req.query.dinh_dang === undefined ? 'docx' : String(req.query.dinh_dang);
      if (dd !== 'docx' && dd !== 'pdf') return loi(res, 400, 'Định dạng chỉ có thể là docx hoặc pdf.');

      const dot = db
        .prepare('SELECT d.id, d.tieu_de, d.loai, d.ky, v.truong_json FROM bcp_dot d JOIN bcp_mau_phien_ban v ON v.id = d.mau_phien_ban_id WHERE d.id = ?')
        .get(id);
      if (!dot) return loi(res, 404, 'Không tìm thấy đợt báo cáo.');

      const raw = String(req.query.phong === undefined ? 'tat-ca' : req.query.phong);
      let ids = null;
      if (raw !== 'tat-ca') {
        ids = [...new Set(raw.split(',').map((x) => docId(x.trim())))];
        if (ids.length === 0 || ids.includes(null) || ids.length > 200) return loi(res, 400, 'Danh sách phòng không hợp lệ.');
      }

      const rows = db
        .prepare(
          `SELECT b.id, b.phong_id, b.trang_thai, b.du_lieu_json, p.ten AS phong_ten, u.fullname AS nguoi_nop
             FROM bcp_bao_cao b
             JOIN bcp_phong p ON p.id = b.phong_id
             LEFT JOIN users u ON u.id = b.nguoi_nop_id
            WHERE b.dot_id = ? ORDER BY p.ten`
        )
        .all(id);
      const daNop = (r) => r.trang_thai === 'da_nop' || r.trang_thai === 'da_duyet';
      let chon;
      if (ids === null) chon = rows.filter(daNop);
      else {
        chon = rows.filter((r) => ids.includes(r.phong_id));
        if (chon.length !== ids.length) return loi(res, 404, 'Có phòng không thuộc đợt báo cáo này.');
        const chua = chon.filter((r) => !daNop(r));
        if (chua.length) {
          return loi(res, 409, 'Chưa xuất được vì phòng chưa nộp (hoặc đang chờ chỉnh sửa): ' + chua.map((r) => r.phong_ten).join('; ') + '.');
        }
      }
      if (!chon.length) return loi(res, 409, 'Đợt này chưa có báo cáo nào đã nộp để xuất.');

      const truong = parseJson(dot.truong_json, []);
      const moHinhs = chon.map((r) =>
        Xuat.dungMoHinh({
          dot,
          truong,
          baoCao: { phong_ten: r.phong_ten, nguoi_nop: r.nguoi_nop || '', du_lieu: parseJson(r.du_lieu_json, {}) },
        })
      );
      const buf = dd === 'pdf' ? await Xuat.taoPdf(moHinhs) : await Xuat.taoDocx(moHinhs);

      db.prepare('INSERT INTO bcp_dot_lich_su (dot_id, hanh_dong, nguoi_id, ghi_chu) VALUES (?,?,?,?)').run(
        id, 'xuat', req.user.id, dd.toUpperCase() + ': ' + chon.map((r) => r.phong_ten).join('; ')
      );

      // Tiêu đề đợt thường đã bắt đầu bằng "Báo cáo …": không thêm tiền tố lần nữa (tránh "Báo cáo Báo cáo…").
      const goc = /^báo cáo/i.test(dot.tieu_de) ? dot.tieu_de : 'Báo cáo ' + dot.tieu_de;
      const ten = `${goc} - ${chon.length === 1 ? chon[0].phong_ten : chon.length + ' phòng'}.${dd}`;
      res.setHeader('Content-Type', MIME_XUAT[dd]);
      // ?xem=1 (chỉ PDF): mở thẳng trong trình duyệt để xem trước, thay vì tải về.
      res.setHeader('Content-Disposition', contentDisposition(ten, { inline: dd === 'pdf' && req.query.xem === '1' }));
      res.setHeader('Content-Length', buf.length);
      // Nội dung nội bộ, có thể chứa số liệu chưa công bố: không cho trình duyệt/proxy lưu đệm.
      res.setHeader('Cache-Control', 'no-store');
      res.end(buf);
    })
  );

  // ══ HỒ SƠ TRÌNH VIỆN TRƯỞNG (thuộc về một đợt) ════════════════════════════
  if (uploadsRoot) {
    router.use('/dot/:id/trinh', canQuanLy, createTrinhRouter({ db, uploadsRoot, thongBao, guiNen, loi, bao, docId }));
  }

  return router;
};
