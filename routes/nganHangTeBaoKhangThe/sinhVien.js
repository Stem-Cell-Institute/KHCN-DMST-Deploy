'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — danh sách sinh viên của Viện (Trung tâm quản lý người học cung cấp). 4 endpoint + cổng chặn.
 * Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js). Chỉ Admin / quản lý module.
 *
 * Quy trình và lý do thiết kế: services/nganHangTeBaoKhangTheSinhVien.js. Tóm tắt:
 *   nhập danh sách → hệ thống tạo sẵn tài khoản `sinh_vien` CHƯA kích hoạt → sinh viên đăng ký bằng đúng email đó và xác minh hộp thư
 *   → dùng được Đặt lịch thiết bị + module này tới hết hạn; hết hạn thì CHỈ khóa module này (tài khoản vẫn dùng Đặt lịch).
 *
 * Tài khoản `crd_user` cũ trùng email với danh sách được ĐẶT LẠI về chưa kích hoạt: ở module Đặt lịch, đăng ký không xác minh
 * hộp thư, nên người cầm tài khoản đó chưa chắc là chủ email. Chủ thật xác minh lại là lấy lại được; kẻ chiếm trước mất quyền.
 */

const express = require('express');
const { HOLDING, toInt, toStr, chuanHoaTen } = require('../../services/nganHangTeBaoKhangThe');
const SV = require('../../services/nganHangTeBaoKhangTheSinhVien');

const LOI_HET_HAN =
  'Quyền vào Ngân hàng tế bào & Kháng thể của tài khoản sinh viên đã hết hạn hoặc đã bị thu hồi. Liên hệ quản lý module để gia hạn (Đặt lịch thiết bị vẫn dùng được).';

module.exports = function createSinhVienRouter(ctx) {
  const { db, requireManage, audit, fail, logNhieuMau } = ctx;
  const router = express.Router();

  const taiKhoan = (email) => db.prepare('SELECT id, email, fullname, role, password FROM users WHERE email = ?').get(email);
  const daKichHoat = (u) => !!u && String(u.password || '').trim() !== '';

  /** Hồ sơ module của sinh viên hết hạn / bị thu hồi: «đã rời đi» (yêu cầu về mẫu của họ tự chuyển cho trưởng nhóm / quản lý). */
  function khoaHoSo(user) {
    if (!user) return;
    const hs = db.prepare('SELECT trang_thai FROM nhm_ho_so WHERE user_id = ?').get(user.id);
    if (!hs || hs.trang_thai === 'da_roi_di') return;
    db.transaction(() => {
      db.prepare("UPDATE nhm_ho_so SET trang_thai = 'da_roi_di', updated_at = datetime('now') WHERE user_id = ?").run(user.id);
      const mau = db.prepare(`SELECT id FROM nhm_tubes WHERE owner_user_id = ? AND deleted_at IS NULL AND status IN ${HOLDING}`).all(user.id).map((r) => r.id);
      logNhieuMau(mau, 'chu_roi_di', null, `${user.fullname || user.email} hết hạn quyền sinh viên vào module`);
    })();
    if (ctx.dinhTuyenLai) ctx.dinhTuyenLai();
  }

  /** Mở lại / tạo hồ sơ module cho sinh viên còn hạn. */
  function moHoSo(user) {
    if (!user) return;
    const hs = db.prepare('SELECT trang_thai FROM nhm_ho_so WHERE user_id = ?').get(user.id);
    if (!hs) {
      db.prepare("INSERT OR IGNORE INTO nhm_ho_so (user_id, loai, trang_thai) VALUES (?, 'sinh_vien', 'dang_hoat_dong')").run(user.id);
    } else if (hs.trang_thai === 'da_roi_di') {
      db.transaction(() => {
        db.prepare("UPDATE nhm_ho_so SET trang_thai = 'dang_hoat_dong', updated_at = datetime('now') WHERE user_id = ?").run(user.id);
        const mau = db.prepare(`SELECT id FROM nhm_tubes WHERE owner_user_id = ? AND deleted_at IS NULL AND status IN ${HOLDING}`).all(user.id).map((r) => r.id);
        logNhieuMau(mau, 'chu_tro_lai', null, `${user.fullname || user.email} được gia hạn quyền sinh viên`);
      })();
      if (ctx.dinhTuyenLai) ctx.dinhTuyenLai();
    }
  }

  /** Đánh dấu dòng hết hạn rồi khóa hồ sơ. */
  function danhDauHetHan(entry) {
    db.prepare("UPDATE nhm_sinh_vien SET trang_thai = 'het_han', updated_at = datetime('now') WHERE id = ? AND trang_thai = 'cho'").run(entry.id);
    khoaHoSo(taiKhoan(entry.email));
  }

  // ---------- cổng chặn: dùng trong index.js ngay sau authMiddleware ----------
  ctx.chanSinhVien = function chanSinhVien(req, res, next) {
    if (String((req.user && req.user.role) || '').toLowerCase() !== 'sinh_vien') return next();
    const e = SV.timTheoEmail(db, req.user.email);
    if (!SV.conHieuLuc(e)) {
      if (e && e.trang_thai === 'cho') danhDauHetHan(e); // hết hạn mà chưa quét: xử lý ngay
      return res.status(403).json({ message: LOI_HET_HAN, hetHan: true });
    }
    moHoSo(req.user);
    req.sinhVienHan = e.het_han;
    next();
  };

  ctx.thongTinSinhVien = (req) => (req.sinhVienHan ? { het_han: req.sinhVienHan } : null);

  /** Quét định kỳ: dòng quá hạn → hết hạn + khóa hồ sơ; xóa dòng đã hết hạn / thu hồi quá lâu. */
  ctx.quetSinhVien = function quetSinhVien(ms = Date.now()) {
    const hom = SV.homNay(ms);
    const ds = db.prepare("SELECT * FROM nhm_sinh_vien WHERE trang_thai = 'cho' AND het_han < ?").all(hom);
    ds.forEach(danhDauHetHan);
    // giữ dòng đã hết hạn / thu hồi thêm HAN_GIU_NGAY ngày KỂ TỪ LÚC ĐÓ (updated_at), rồi xóa dữ liệu cá nhân
    const cu = new Date(ms - SV.HAN_GIU_NGAY * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    const xoa = db.prepare("DELETE FROM nhm_sinh_vien WHERE trang_thai IN ('het_han','da_xoa') AND updated_at < ?").run(cu);
    return { hetHan: ds.length, daXoa: xoa.changes };
  };

  // ---------- danh sách ----------

  const tinhTrang = (s, u) => {
    if (s.trang_thai === 'da_xoa') return 'da_xoa';
    if (!SV.conHieuLuc(s)) return 'het_han';
    return daKichHoat(u) ? 'da_kich_hoat' : 'cho_kich_hoat';
  };

  router.get('/students', requireManage, (req, res) => {
    const tatCa = req.query.all === '1';
    const rows = db
      .prepare(
        `SELECT s.*, u.id AS user_id, u.password AS mk, u.role AS vai_tro, g.ten AS nhom_ten
         FROM nhm_sinh_vien s LEFT JOIN users u ON u.email = s.email
         LEFT JOIN nhm_ho_so h ON h.user_id = u.id LEFT JOIN nhm_nhom g ON g.id = h.nhom_id
         ${tatCa ? '' : "WHERE s.trang_thai <> 'da_xoa'"} ORDER BY s.het_han, s.fullname COLLATE NOCASE LIMIT 5000`
      )
      .all();
    const tu = chuanHoaTen(typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '');
    const loc = typeof req.query.tinh_trang === 'string' ? req.query.tinh_trang : '';
    const items = rows
      .map((s) => ({
        id: s.id, email: s.email, fullname: s.fullname, ma_sv: s.ma_sv, khoa: s.khoa, het_han: s.het_han, ghi_chu: s.ghi_chu,
        tinh_trang: tinhTrang(s, { password: s.mk }), vai_tro_tk: s.vai_tro, nhom_ten: s.nhom_ten, created_at: s.created_at,
      }))
      .filter((x) => (!loc || x.tinh_trang === loc) && (!tu || chuanHoaTen(`${x.email} ${x.fullname} ${x.ma_sv || ''} ${x.khoa || ''}`).includes(tu)));
    audit(req, 'students_view', `${items.length} dòng`);
    res.json({ students: items, hom_nay: SV.homNay() });
  });

  // ---------- nhập danh sách (dán hoặc tệp Excel / CSV), có xem trước ----------

  /**
   * Áp dụng (hoặc chỉ tính thử khi `thu`) một danh sách đã đọc xong. Không ghi gì khi thu = true.
   * @returns {object} số liệu + lỗi từng dòng
   */
  function nhapDong(req, rows, loiDoc, thu) {
    const hom = SV.homNay();
    const kq = { moi: 0, cap_nhat: 0, bo_qua: 0, tao_tai_khoan: 0, dat_lai_crd: 0, tai_khoan_khac: 0, loi: loiDoc.slice(), mau: [] };
    const lam = () => {
      const trung = new Set();
      for (const r of rows) {
        if (r.email.endsWith('@sci.edu.vn')) { kq.bo_qua++; kq.loi.push({ dong: r.dong, message: 'Email @sci.edu.vn đăng ký tài khoản bình thường, không cần nằm trong danh sách.' }); continue; }
        if (trung.has(r.email)) { kq.bo_qua++; kq.loi.push({ dong: r.dong, message: 'Email trùng với một dòng trước trong danh sách này.' }); continue; }
        trung.add(r.email);
        if (r.het_han < hom) { kq.bo_qua++; kq.loi.push({ dong: r.dong, message: 'Hạn dùng đã qua.' }); continue; }
        const co = SV.timTheoEmail(db, r.email);
        if (kq.mau.length < 8) kq.mau.push({ dong: r.dong, email: r.email, fullname: r.fullname, khoa: r.khoa, het_han: r.het_han, cap_nhat: !!co });
        if (co) {
          if (!thu) db.prepare("UPDATE nhm_sinh_vien SET fullname = ?, ma_sv = ?, khoa = ?, het_han = ?, trang_thai = 'cho', updated_at = datetime('now') WHERE id = ?").run(r.fullname, r.ma_sv, r.khoa, r.het_han, co.id);
          kq.cap_nhat++;
        } else {
          if (!thu) db.prepare('INSERT INTO nhm_sinh_vien (email, fullname, ma_sv, khoa, het_han, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(r.email, r.fullname, r.ma_sv, r.khoa, r.het_han, req.user.id);
          kq.moi++;
        }
        const u = taiKhoan(r.email);
        if (!u) {
          // tài khoản tạo sẵn CHƯA kích hoạt (mật khẩu rỗng): chỉ xác minh hộp thư mới đặt được mật khẩu
          if (!thu) db.prepare("INSERT INTO users (email, password, fullname, role) VALUES (?, '', ?, 'sinh_vien')").run(r.email, r.fullname);
          kq.tao_tai_khoan++;
        } else if (String(u.role || '').toLowerCase() === 'crd_user') {
          if (!thu) db.prepare("UPDATE users SET role = 'sinh_vien', password = '' WHERE id = ?").run(u.id);
          kq.dat_lai_crd++;
        } else if (String(u.role || '').toLowerCase() === 'sinh_vien') {
          if (!thu && daKichHoat(u)) moHoSo(u); // gia hạn: mở lại hồ sơ nếu đã bị khóa
        } else {
          kq.tai_khoan_khac++; // đã có tài khoản vai trò khác: không đụng tới
        }
      }
    };
    if (thu) lam();
    else db.transaction(lam)();
    kq.loi = kq.loi.slice(0, 100);
    return kq;
  }

  /** Dùng chung cho dán văn bản và tải tệp: đọc → (xem trước | nhập) → trả kết quả. */
  function traKetQuaNhap(req, res, doc, thu, nguon) {
    if (!doc.rows.length && !doc.loi.length) return fail(res, 400, 'Danh sách trống.');
    const kq = nhapDong(req, doc.rows, doc.loi, thu);
    kq.xem_truoc = !!thu;
    kq.co_tieu_de = doc.coTieuDe;
    if (!thu) audit(req, 'students_import', nguon + ': ' + kq.moi + ' mới, ' + kq.cap_nhat + ' cập nhật, ' + kq.bo_qua + ' bỏ qua, ' + kq.dat_lai_crd + ' tài khoản CRD cũ đặt lại, ' + kq.loi.length + ' lỗi');
    return res.status(kq.moi + kq.cap_nhat || thu ? 200 : 400).json(kq);
  }

  const hanMacDinhTu = (body) => {
    const h = body && body.het_han ? SV.chuanHoaNgay(body.het_han) : null;
    return { h, sai: !!(body && body.het_han) && !h };
  };

  router.post('/students/import', requireManage, (req, res) => {
    const body = req.body || {};
    const { h, sai } = hanMacDinhTu(body);
    if (sai) return fail(res, 400, 'Hạn dùng mặc định không hợp lệ (YYYY-MM-DD hoặc DD/MM/YYYY).');
    const doc = SV.docDanhSach(body.text, h);
    return traKetQuaNhap(req, res, doc, body.xem_truoc === true || body.xem_truoc === 'true', 'dán');
  });

  // Tệp Excel (.xlsx) hoặc .csv: multipart, trường «tep»; kèm het_han (mặc định) và xem_truoc=1. Chỉ giữ trong bộ nhớ, không ghi đĩa.
  const upload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: SV.TOI_DA_BYTE, files: 1, fields: 5 } });
  router.post('/students/import-file', requireManage, (req, res, next) => {
    upload.single('tep')(req, res, (e) => {
      if (e) return fail(res, 400, e.code === 'LIMIT_FILE_SIZE' ? 'Tệp quá lớn (tối đa 2 MB).' : 'Không nhận được tệp: ' + e.message);
      next();
    });
  }, async (req, res) => {
    const { h, sai } = hanMacDinhTu(req.body);
    if (sai) return fail(res, 400, 'Hạn dùng mặc định không hợp lệ (YYYY-MM-DD hoặc DD/MM/YYYY).');
    if (!req.file) return fail(res, 400, 'Chưa chọn tệp.');
    try {
      const doc = await SV.docTep(req.file.buffer, req.file.originalname, h);
      return traKetQuaNhap(req, res, doc, req.body.xem_truoc === '1' || req.body.xem_truoc === 'true', 'tệp');
    } catch (e) {
      if (e.status) return fail(res, e.status, e.message);
      console.error('[ngan-hang] đọc tệp sinh viên lỗi:', e);
      return fail(res, 500, 'Có lỗi khi đọc tệp.');
    }
  });

  router.get('/students/template.xlsx', requireManage, async (req, res) => {
    try {
      const buf = await SV.taoMauXlsx();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="mau-danh-sach-sinh-vien.xlsx"');
      res.send(buf);
    } catch (e) {
      console.error('[ngan-hang] tạo tệp mẫu lỗi:', e);
      fail(res, 500, 'Không tạo được tệp mẫu.');
    }
  });

  // ---------- thao tác cả đợt (khóa / đợt nhận vào, đợt ra trường) ----------

  router.post('/students/bulk', requireManage, (req, res) => {
    const body = req.body || {};
    const khoa = body.khoa == null ? '' : String(body.khoa).trim();
    const hanhDong = body.hanh_dong;
    if (!['gia_han', 'ra_truong', 'thu_hoi'].includes(hanhDong)) return fail(res, 400, 'Hành động không hợp lệ (gia hạn, ra trường, thu hồi).');
    let han = null;
    if (hanhDong === 'gia_han') {
      han = SV.chuanHoaNgay(body.het_han);
      if (!han || han < SV.homNay()) return fail(res, 400, 'Gia hạn cần một hạn dùng mới từ hôm nay trở đi.');
    }
    const ds = db
      .prepare(`SELECT * FROM nhm_sinh_vien WHERE trang_thai IN ('cho','het_han') AND COALESCE(khoa, '') = ?`)
      .all(khoa);
    if (!ds.length) return fail(res, 404, 'Không có sinh viên nào thuộc đợt này.');
    const hom = SV.homNay();
    const homQua = SV.homNay(Date.now() - 86400000);
    db.transaction(() => {
      for (const e of ds) {
        if (hanhDong === 'gia_han') {
          db.prepare("UPDATE nhm_sinh_vien SET het_han = ?, trang_thai = 'cho', updated_at = datetime('now') WHERE id = ?").run(han, e.id);
          const u = taiKhoan(e.email);
          if (u && String(u.role).toLowerCase() === 'sinh_vien' && daKichHoat(u)) moHoSo(u);
        } else if (hanhDong === 'ra_truong') {
          // đợt đã ra trường: hết hạn từ hôm qua, khóa quyền vào module ngay
          db.prepare("UPDATE nhm_sinh_vien SET het_han = ?, trang_thai = 'het_han', updated_at = datetime('now') WHERE id = ?").run(homQua, e.id);
          khoaHoSo(taiKhoan(e.email));
        } else {
          db.prepare("UPDATE nhm_sinh_vien SET trang_thai = 'da_xoa', updated_at = datetime('now') WHERE id = ?").run(e.id);
          khoaHoSo(taiKhoan(e.email));
        }
      }
    })();
    audit(req, 'students_bulk', `${hanhDong} đợt «${khoa || '(không ghi đợt)'}»: ${ds.length} sinh viên${han ? ', hạn mới ' + han : ''}`);
    res.json({ ok: true, so_luong: ds.length, hom_nay: hom });
  });

  // ---------- sửa / gia hạn / thu hồi ----------

  router.patch('/students/:id', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT * FROM nhm_sinh_vien WHERE id = ?').get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy dòng trong danh sách.');
    const body = req.body || {};
    const upd = {};
    if ('fullname' in body) {
      upd.fullname = toStr(body.fullname, 150);
      if (!upd.fullname || upd.fullname.length < 2) return fail(res, 400, 'Họ tên phải từ 2 đến 150 ký tự.');
    }
    if ('ma_sv' in body) upd.ma_sv = toStr(body.ma_sv, 40);
    if ('khoa' in body) upd.khoa = toStr(body.khoa, 60);
    if ('ghi_chu' in body) upd.ghi_chu = toStr(body.ghi_chu, 300);
    if ('het_han' in body) {
      upd.het_han = SV.chuanHoaNgay(body.het_han);
      if (!upd.het_han) return fail(res, 400, 'Hạn dùng không hợp lệ (YYYY-MM-DD hoặc DD/MM/YYYY).');
    }
    if (!Object.keys(upd).length) return fail(res, 400, 'Không có dữ liệu cần cập nhật.');
    if (cur.trang_thai === 'da_xoa') return fail(res, 409, 'Dòng này đã bị thu hồi; hãy nhập lại danh sách để cấp lại.');
    const cols = Object.keys(upd);
    db.transaction(() => {
      const dat = cols.map((c) => c + ' = ?').join(', ');
      db.prepare(`UPDATE nhm_sinh_vien SET ${dat}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map((c) => upd[c]), id);
      if (upd.het_han && upd.het_han >= SV.homNay()) {
        // gia hạn: đang «hết hạn» thì mở lại, và mở lại hồ sơ module
        db.prepare("UPDATE nhm_sinh_vien SET trang_thai = 'cho' WHERE id = ? AND trang_thai = 'het_han'").run(id);
        const u = taiKhoan(cur.email);
        if (u && String(u.role).toLowerCase() === 'sinh_vien' && daKichHoat(u)) moHoSo(u);
      }
    })();
    if (upd.het_han && upd.het_han < SV.homNay()) khoaHoSo(taiKhoan(cur.email)); // cắt hạn về quá khứ: khóa ngay
    audit(req, 'students_update', `#${id}${upd.het_han ? ` hạn ${cur.het_han} → ${upd.het_han}` : ''} (${cols.join(', ')})`);
    res.json({ ok: true });
  });

  router.delete('/students/:id', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT * FROM nhm_sinh_vien WHERE id = ?').get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy dòng trong danh sách.');
    if (cur.trang_thai === 'da_xoa') return fail(res, 409, 'Dòng này đã được thu hồi.');
    db.prepare("UPDATE nhm_sinh_vien SET trang_thai = 'da_xoa', updated_at = datetime('now') WHERE id = ?").run(id);
    khoaHoSo(taiKhoan(cur.email));
    audit(req, 'students_revoke', `#${id}`);
    res.json({ ok: true });
  });

  return router;
};
