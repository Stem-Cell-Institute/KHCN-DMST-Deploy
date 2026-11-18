'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — quản lý danh mục: loại vị trí lưu trữ, mẫu hộp, loại mẫu. 9 endpoint,
 * chỉ Admin / Manager / Phòng KHCN (đọc danh mục vẫn qua GET /meta, mọi người dùng đều xem được).
 * Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 */

const express = require('express');
const NhacViec = require('../../services/nganHangTeBaoKhangTheNhacViec');
const { toInt, toStr, parseSo, isUniqueError, layThayDoi, moTaThayDoi } = require('../../services/nganHangTeBaoKhangThe');

module.exports = function createDanhMucRouter(ctx) {
  const { db, requireManage, audit, fail, YeuCau } = ctx;
  const router = express.Router();

  const doiTuong = {
    // đọc body -> [giá trị, lỗi]
    'container-types': {
      bang: 'nhm_container_types',
      ten: 'loại vị trí lưu trữ',
      doc(body, tuyChon) {
        const out = {};
        let loi = null;
        if (!tuyChon || 'name' in body) out.name = toStr(body.name, 100);
        if ('default_temp_c' in body) {
          const r = parseSo(body.default_temp_c, { min: -273, max: 100, label: 'Nhiệt độ mặc định' });
          if (r.error) loi = r.error;
          else out.default_temp_c = r.value;
        }
        if ('sort_order' in body) {
          out.sort_order = body.sort_order == null || body.sort_order === '' ? 0 : toInt(body.sort_order);
          if (out.sort_order == null) loi = 'Thứ tự sắp xếp phải là số nguyên.';
        }
        return [out, loi];
      },
      dangDung: (id) => db.prepare('SELECT COUNT(*) AS c FROM nhm_containers WHERE type_id = ?').get(id).c,
      dangDungMsg: (n) => `Không thể xóa: ${n} vị trí lưu trữ đang dùng loại này.`,
    },
    'box-templates': {
      bang: 'nhm_box_templates',
      ten: 'mẫu hộp',
      doc(body, tuyChon) {
        const out = {};
        let loi = null;
        if (!tuyChon || 'name' in body) out.name = toStr(body.name, 100);
        for (const [k, max, nhan] of [['rows', 26, 'Số hàng'], ['cols', 30, 'Số cột']]) {
          if (!tuyChon || k in body) {
            const n = toInt(body[k]);
            if (n == null || n < 1 || n > max) loi = `${nhan} phải từ 1 đến ${max}.`;
            else out[k] = n;
          }
        }
        return [out, loi];
      },
      // Hộp chỉ chụp lại rows/cols từ mẫu, nên xóa mẫu chỉ cần gỡ liên kết, không làm hộp cũ vỡ.
      dangDung: (id) => db.prepare('SELECT COUNT(*) AS c FROM nhm_boxes WHERE template_id = ? AND deleted_at IS NULL').get(id).c,
      khiXoa: (id) => db.prepare('UPDATE nhm_boxes SET template_id = NULL WHERE template_id = ?').run(id),
      // Không đổi kích thước mẫu đã có hộp dùng, vì template_id của hộp sẽ nói sai.
      khoaKhiDangDung: ['rows', 'cols'],
      khoaMsg: (n) => `Không thể đổi kích thước: ${n} hộp đang dùng mẫu này. Hãy tạo mẫu mới.`,
    },
    'sample-types': {
      bang: 'nhm_sample_types',
      ten: 'loại mẫu',
      doc(body, tuyChon) {
        const out = {};
        if (!tuyChon || 'name' in body) out.name = toStr(body.name, 100);
        return [out, null];
      },
      dangDung: (id) => db.prepare('SELECT COUNT(*) AS c FROM nhm_tubes WHERE sample_type_id = ?').get(id).c,
      dangDungMsg: (n) => `Không thể xóa: ${n} mẫu đang thuộc loại này (kể cả mẫu đã rã đông / hủy).`,
    },
  };

  Object.keys(doiTuong).forEach((duongDan) => {
    const d = doiTuong[duongDan];
    const lay = (id) => id && db.prepare(`SELECT * FROM ${d.bang} WHERE id = ?`).get(id);
    const hau = duongDan.replace(/-/g, '_'); // tên hành động trong nhật ký: container_types_create...
    const trung = `Tên ${d.ten} đã tồn tại.`;

    router.post(`/${duongDan}`, requireManage, (req, res) => {
      const [v, loi] = d.doc(req.body || {}, false);
      if (loi) return fail(res, 400, loi);
      if (!v.name) return fail(res, 400, `Thiếu tên ${d.ten}.`);
      const cols = Object.keys(v);
      try {
        const info = db
          .prepare(`INSERT INTO ${d.bang} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          .run(...cols.map((c) => v[c]));
        audit(req, `${hau}_create`, `id=${info.lastInsertRowid} ${v.name}`);
        res.status(201).json({ id: Number(info.lastInsertRowid) });
      } catch (e) {
        if (isUniqueError(e)) return fail(res, 409, trung);
        throw e;
      }
    });

    router.patch(`/${duongDan}/:id`, requireManage, (req, res) => {
      const id = toInt(req.params.id);
      const cur = lay(id);
      if (!cur) return fail(res, 404, `Không tìm thấy ${d.ten}.`);
      const [v, loi] = d.doc(req.body || {}, true);
      if (loi) return fail(res, 400, loi);
      if ('name' in v && !v.name) return fail(res, 400, `Tên ${d.ten} không được để trống.`);
      if (!Object.keys(v).length) return fail(res, 400, 'Không có dữ liệu cần cập nhật.');
      const thayDoi = layThayDoi(cur, v);
      const cols = Object.keys(thayDoi);
      if (!cols.length) return res.json({ ok: true, changed: 0 });
      if (d.khoaKhiDangDung && cols.some((c) => d.khoaKhiDangDung.includes(c))) {
        const n = d.dangDung(id);
        if (n > 0) return fail(res, 409, d.khoaMsg(n));
      }
      try {
        db.prepare(`UPDATE ${d.bang} SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map((c) => v[c]), id);
        audit(req, `${hau}_update`, `id=${id} ${cur.name}: ${moTaThayDoi(thayDoi)}`);
        res.json({ ok: true, changed: cols.length });
      } catch (e) {
        if (isUniqueError(e)) return fail(res, 409, trung);
        throw e;
      }
    });

    router.delete(`/${duongDan}/:id`, requireManage, (req, res) => {
      const id = toInt(req.params.id);
      const cur = lay(id);
      if (!cur) return fail(res, 404, `Không tìm thấy ${d.ten}.`);
      const n = d.dangDung(id);
      if (n > 0 && d.dangDungMsg) return fail(res, 409, d.dangDungMsg(n));
      db.transaction(() => {
        if (d.khiXoa) d.khiXoa(id);
        db.prepare(`DELETE FROM ${d.bang} WHERE id = ?`).run(id);
      })();
      audit(req, `${hau}_delete`, `id=${id} ${cur.name}`);
      res.json({ ok: true });
    });
  });

  // ---------- cấu hình các hạn chờ ----------
  // Ai cũng đọc được (giao diện cần nói đúng «sau 7 ngày…»); chỉ quản lý chỉnh. Chỉ ảnh hưởng yêu cầu / vụ việc tạo SAU khi lưu
  // (hạn đã ghi cho yêu cầu và vụ việc đang chạy giữ nguyên); riêng hạn bỏ mẫu chưa khai báo được tính lúc đọc nên đổi là áp dụng ngay.
  router.get('/settings', (req, res) => {
    res.json({
      han: YeuCau.layHan(db), mac_dinh: YeuCau.HAN_MAC_DINH, gioi_han: YeuCau.GIOI_HAN_HAN, nhan: YeuCau.NHAN_HAN,
      // chu kỳ nhắc việc định kỳ (kiểm kê, QC, nhiệt độ): áp dụng ngay khi lưu
      chu_ky: NhacViec.layChuKy(db), chu_ky_mac_dinh: NhacViec.CHU_KY_MAC_DINH, chu_ky_gioi_han: NhacViec.GIOI_HAN_CHU_KY, chu_ky_nhan: NhacViec.NHAN_CHU_KY,
    });
  });

  router.put('/settings', requireManage, (req, res) => {
    const body = req.body || {};
    const moi = {};
    const moiChuKy = {};
    for (const k of Object.keys(YeuCau.KHOA_HAN)) {
      if (!(k in body)) continue;
      const n = toInt(body[k]);
      const [min, max] = YeuCau.GIOI_HAN_HAN[k];
      if (n == null || n < min || n > max) return fail(res, 400, `${YeuCau.NHAN_HAN[k]}: phải là số nguyên từ ${min} đến ${max} ngày.`);
      moi[k] = n;
    }
    for (const k of Object.keys(NhacViec.KHOA_CHU_KY)) {
      if (!(k in body)) continue;
      const n = toInt(body[k]);
      const [min, max] = NhacViec.GIOI_HAN_CHU_KY[k];
      if (n == null || n < min || n > max) return fail(res, 400, `${NhacViec.NHAN_CHU_KY[k]}: phải là số nguyên từ ${min} đến ${max} ngày.`);
      moiChuKy[k] = n;
    }
    if (!Object.keys(moi).length && !Object.keys(moiChuKy).length) return fail(res, 400, 'Không có hạn nào cần cập nhật.');
    const truoc = YeuCau.layHan(db);
    const truocCk = NhacViec.layChuKy(db);
    const doi = Object.keys(moi).filter((k) => moi[k] !== truoc[k]);
    const doiCk = Object.keys(moiChuKy).filter((k) => moiChuKy[k] !== truocCk[k]);
    if (doi.length) YeuCau.luuHan(db, moi, req.user.id);
    if (doiCk.length) NhacViec.luuChuKy(db, moiChuKy, req.user.id);
    if (doi.length || doiCk.length) {
      audit(req, 'settings_update', doi.map((k) => `${YeuCau.NHAN_HAN[k]}: ${truoc[k]} → ${moi[k]} ngày`).concat(doiCk.map((k) => `${NhacViec.NHAN_CHU_KY[k]}: ${truocCk[k]} → ${moiChuKy[k]} ngày`)).join('; '));
    }
    res.json({ ok: true, changed: doi.length + doiCk.length, han: YeuCau.layHan(db), chu_ky: NhacViec.layChuKy(db) });
  });

  return router;
};
