'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — ĐỢT KIỂM KÊ: đối chiếu sổ với thực tế cho cả một thiết bị / ngăn / Rack, theo dõi tiến độ từng hộp.
 * 6 endpoint. Mỗi hộp được kiểm bằng đúng thao tác «kiểm kê hộp» (ctx.kiemKeHop, phatHien.js): mẫu không thấy mở vụ việc nghi mất,
 * mẫu thấy được ghi «lần cuối thấy», hộp được ghi mốc kiểm kê để tính hạn kiểm kê kế tiếp (chu kỳ ở Cấu hình hạn).
 *
 * Quyền: giống kiểm kê hộp — Admin / Quản lý module / Viện trưởng và phải có quyền với thiết bị (ctx.duocKiemKe).
 * Danh sách hộp chụp lúc mở đợt (chỉ hộp đang có mẫu lưu kho). Một hộp chỉ kiểm một lần trong một đợt; sai sót sửa bằng «Kiểm kê hộp» lẻ.
 * Đợt kiểm kê không xóa được (trigger); kết thúc khi còn hộp chưa kiểm phải ghi lý do.
 */

const express = require('express');
const { toInt, toStr, isUniqueError } = require('../../services/nganHangTeBaoKhangThe');

module.exports = function createKiemKeRouter(ctx) {
  const { db, canManage, audit, fail, nhanNguoi, duongDan, subtreeIds, tapAn, laVienTruong } = ctx;
  const router = express.Router();

  const choPhep = (req) => canManage(req) || laVienTruong(req);
  const layDot = (id) => db.prepare('SELECT * FROM nhm_kiem_ke WHERE id = ?').get(id);
  const ten = (path) => path.join(' › ');

  /** Đợt này người đang gọi được thấy: đúng ngân hàng, thiết bị không bị ẩn, và có quyền kiểm kê với thiết bị. */
  const thayDuoc = (req, d) => d && d.ngan_hang === req.nganHang && !tapAn(req).containers.has(d.container_id) && ctx.duocKiemKe(req, d.container_id);

  const tienDo = (id) =>
    db.prepare(
      `SELECT COUNT(*) AS tong, SUM(trang_thai = 'xong') AS xong, COALESCE(SUM(so_thay), 0) AS so_thay, COALESCE(SUM(so_khong_thay), 0) AS so_khong_thay,
              COALESCE(SUM(so_vu_viec), 0) AS so_vu_viec, COALESCE(SUM(so_mau), 0) AS so_mau
       FROM nhm_kiem_ke_hop WHERE kiem_ke_id = ?`
    ).get(id);

  function dinhDang(d) {
    const td = tienDo(d.id);
    return {
      id: d.id, ten: d.ten, container_id: d.container_id, duong_dan: ten(duongDan(d.container_id)), trang_thai: d.trang_thai,
      nguoi_tao_ten: d.nguoi_tao_ten, created_at: d.created_at, ket_thuc_luc: d.ket_thuc_luc, ket_thuc_ten: d.ket_thuc_ten, ly_do: d.ly_do,
      tong_hop: td.tong, hop_xong: td.xong || 0, so_mau: td.so_mau, so_thay: td.so_thay, so_khong_thay: td.so_khong_thay, so_vu_viec: td.so_vu_viec,
    };
  }

  /** Hộp (còn tồn tại, có mẫu lưu kho) trong thiết bị / ngăn / Rack này và mọi cấp con. */
  function hopCanKiem(containerId) {
    const ids = subtreeIds(containerId);
    return db
      .prepare(
        `SELECT b.id, b.code, b.container_id,
                (SELECT COUNT(*) FROM nhm_tubes t WHERE t.box_id = b.id AND t.deleted_at IS NULL AND t.status = 'in_storage') AS so_mau
         FROM nhm_boxes b WHERE b.deleted_at IS NULL AND b.container_id IN (${ids.map(() => '?').join(',')}) ORDER BY b.container_id, COALESCE(b.vi_tri, 999), b.id`
      )
      .all(...ids)
      .filter((b) => b.so_mau > 0);
  }

  router.post('/inventories', (req, res) => {
    if (!choPhep(req)) return fail(res, 403, 'Chỉ Admin hoặc Quản lý module mới mở được đợt kiểm kê.');
    const cid = toInt((req.body || {}).container_id);
    const c = cid && db.prepare('SELECT id, name, parent_id, ngan_hang FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(cid);
    if (!c) return fail(res, 404, 'Không tìm thấy vị trí lưu trữ.');
    if (!ctx.duocKiemKe(req, cid)) return fail(res, 403, 'Chỉ Admin, Quản lý module hoặc chủ thiết bị riêng mới có quyền thao tác này.');
    // không để hai đợt đang làm chồng lên nhau (cùng vị trí, vị trí cha hoặc vị trí con)
    const chong = new Set(subtreeIds(cid));
    for (let p = c.parent_id, i = 0; p != null && i < 50; i++) {
      chong.add(p);
      p = (db.prepare('SELECT parent_id FROM nhm_containers WHERE id = ?').get(p) || {}).parent_id;
    }
    const dangLam = db.prepare("SELECT id, container_id FROM nhm_kiem_ke WHERE trang_thai = 'dang_lam'").all().find((d) => chong.has(d.container_id));
    if (dangLam) return fail(res, 409, `Đã có đợt kiểm kê #${dangLam.id} đang làm ở vị trí này hoặc vị trí liên quan. Hãy kết thúc hoặc hủy đợt đó trước.`);
    const hop = hopCanKiem(cid);
    if (!hop.length) return fail(res, 400, 'Vị trí này chưa có hộp nào đang chứa mẫu để kiểm kê.');
    const homNay = ctx.YeuCau.homNayVn().split('-').reverse().join('/');
    const tenDot = toStr((req.body || {}).ten, 150) || `Kiểm kê ${c.name} ${homNay}`;
    try {
      const id = db.transaction(() => {
        const info = db
          .prepare('INSERT INTO nhm_kiem_ke (ngan_hang, container_id, ten, nguoi_tao_id, nguoi_tao_ten) VALUES (?, ?, ?, ?, ?)')
          .run(req.nganHang, cid, tenDot, req.user.id, nhanNguoi(req.user.id));
        const them = db.prepare('INSERT INTO nhm_kiem_ke_hop (kiem_ke_id, box_id, so_mau) VALUES (?, ?, ?)');
        for (const b of hop) them.run(info.lastInsertRowid, b.id, b.so_mau);
        return Number(info.lastInsertRowid);
      })();
      audit(req, 'inventory_create', `#${id} ${tenDot}: ${hop.length} hộp, ${hop.reduce((s, b) => s + b.so_mau, 0)} mẫu`);
      res.status(201).json({ id, so_hop: hop.length, so_mau: hop.reduce((s, b) => s + b.so_mau, 0) });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Vị trí này đã có đợt kiểm kê đang làm.');
      throw e;
    }
  });

  router.get('/inventories', (req, res) => {
    if (!choPhep(req)) return fail(res, 403, 'Chỉ Admin hoặc Quản lý module mới xem được đợt kiểm kê.');
    const tatCa = req.query.status === 'all';
    const rows = db
      .prepare(`SELECT * FROM nhm_kiem_ke WHERE ngan_hang = ? ${tatCa ? '' : "AND (trang_thai = 'dang_lam' OR ket_thuc_luc >= datetime('now', '-90 days'))"} ORDER BY (trang_thai = 'dang_lam') DESC, id DESC LIMIT 200`)
      .all(req.nganHang)
      .filter((d) => thayDuoc(req, d));
    res.json({ inventories: rows.map(dinhDang) });
  });

  function layDotThay(req, res) {
    if (!choPhep(req)) { fail(res, 403, 'Chỉ Admin hoặc Quản lý module mới xem được đợt kiểm kê.'); return null; }
    const id = toInt(req.params.id);
    const d = id && layDot(id);
    if (!d || !thayDuoc(req, d)) { fail(res, 404, 'Không tìm thấy đợt kiểm kê.'); return null; }
    return d;
  }

  const hopCuaDot = (id) =>
    db
      .prepare(
        `SELECT h.*, b.code, b.name, b.container_id FROM nhm_kiem_ke_hop h JOIN nhm_boxes b ON b.id = h.box_id WHERE h.kiem_ke_id = ?
         ORDER BY b.container_id, COALESCE(b.vi_tri, 999), b.id`
      )
      .all(id)
      .map((h) => ({ box_id: h.box_id, code: h.code, name: h.name, duong_dan: ten(duongDan(h.container_id)), so_mau: h.so_mau, trang_thai: h.trang_thai, so_thay: h.so_thay, so_khong_thay: h.so_khong_thay, so_vu_viec: h.so_vu_viec, nguoi_ten: h.nguoi_ten, luc: h.luc }));

  router.get('/inventories/:id', (req, res) => {
    const d = layDotThay(req, res);
    if (!d) return;
    res.json({ inventory: dinhDang(d), boxes: hopCuaDot(d.id) });
  });

  router.post('/inventories/:id/boxes/:boxId', (req, res) => {
    const d = layDotThay(req, res);
    if (!d) return;
    if (d.trang_thai !== 'dang_lam') return fail(res, 409, 'Đợt kiểm kê này đã kết thúc.');
    const boxId = toInt(req.params.boxId);
    const h = boxId && db.prepare('SELECT * FROM nhm_kiem_ke_hop WHERE kiem_ke_id = ? AND box_id = ?').get(d.id, boxId);
    if (!h) return fail(res, 404, 'Hộp này không nằm trong đợt kiểm kê.');
    if (h.trang_thai === 'xong') return fail(res, 409, 'Hộp này đã được kiểm kê trong đợt này. Sai sót thì dùng «Kiểm kê hộp» riêng ở hộp đó.');
    const box = db.prepare('SELECT id, code, container_id FROM nhm_boxes WHERE id = ? AND deleted_at IS NULL').get(boxId);
    if (!box) return fail(res, 409, 'Hộp này không còn tồn tại.');
    const kq = ctx.kiemKeHop(req, box, req.body || {}, (r) => {
      db.prepare("UPDATE nhm_kiem_ke_hop SET trang_thai = 'xong', so_thay = ?, so_khong_thay = ?, so_vu_viec = ?, nguoi_id = ?, nguoi_ten = ?, luc = datetime('now') WHERE kiem_ke_id = ? AND box_id = ?")
        .run(r.thay, r.khong_thay, r.vu_viec_moi, req.user.id, nhanNguoi(req.user.id), d.id, boxId);
    });
    if (kq.loi) return fail(res, kq.loi[0], kq.loi[1]);
    const td = tienDo(d.id);
    res.json({ ok: true, ...kq, hop_xong: td.xong || 0, tong_hop: td.tong });
  });

  router.post('/inventories/:id/finish', (req, res) => {
    const d = layDotThay(req, res);
    if (!d) return;
    if (d.trang_thai !== 'dang_lam') return fail(res, 409, 'Đợt kiểm kê này đã kết thúc.');
    const td = tienDo(d.id);
    const chua = td.tong - (td.xong || 0);
    const lyDo = toStr((req.body || {}).ly_do, 500);
    if (chua > 0 && (!lyDo || lyDo.length < 5)) return fail(res, 409, `Còn ${chua} hộp chưa kiểm kê. Hãy kiểm hết, hoặc ghi lý do kết thúc sớm (ít nhất 5 ký tự).`);
    db.prepare("UPDATE nhm_kiem_ke SET trang_thai = 'hoan_tat', ket_thuc_luc = datetime('now'), ket_thuc_boi = ?, ket_thuc_ten = ?, ly_do = ? WHERE id = ?")
      .run(req.user.id, nhanNguoi(req.user.id), chua > 0 ? lyDo : null, d.id);
    audit(req, 'inventory_finish', `#${d.id} ${d.ten}: ${td.xong || 0}/${td.tong} hộp${chua > 0 ? ` (kết thúc sớm: ${lyDo})` : ''}, ${td.so_khong_thay} mẫu không thấy`);
    res.json({ ok: true, hop_chua_kiem: chua });
  });

  router.post('/inventories/:id/cancel', (req, res) => {
    const d = layDotThay(req, res);
    if (!d) return;
    if (d.trang_thai !== 'dang_lam') return fail(res, 409, 'Đợt kiểm kê này đã kết thúc.');
    const lyDo = toStr((req.body || {}).ly_do, 500);
    if (!lyDo || lyDo.length < 5) return fail(res, 400, 'Phải ghi lý do hủy đợt kiểm kê (ít nhất 5 ký tự).');
    db.prepare("UPDATE nhm_kiem_ke SET trang_thai = 'huy', ket_thuc_luc = datetime('now'), ket_thuc_boi = ?, ket_thuc_ten = ?, ly_do = ? WHERE id = ?")
      .run(req.user.id, nhanNguoi(req.user.id), lyDo, d.id);
    audit(req, 'inventory_cancel', `#${d.id} ${d.ten}: ${lyDo}`);
    res.json({ ok: true });
  });

  /** Biên bản kiểm kê dạng CSV (Excel mở được tiếng Việt: có BOM; ô bắt đầu bằng = + - @ được thêm dấu nháy). */
  router.get('/inventories/:id/export.csv', (req, res) => {
    const d = layDotThay(req, res);
    if (!d) return;
    const o = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const dong = [['Mã hộp', 'Tên hộp', 'Vị trí', 'Số mẫu trong sổ', 'Tình trạng', 'Có mặt', 'Không thấy', 'Vụ việc mới', 'Người kiểm', 'Lúc (UTC)']]
      .concat(hopCuaDot(d.id).map((h) => [h.code, h.name, h.duong_dan, h.so_mau, h.trang_thai === 'xong' ? 'Đã kiểm' : 'Chưa kiểm', h.so_thay, h.so_khong_thay, h.so_vu_viec, h.nguoi_ten, h.luc]));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="kiem-ke-${d.id}.csv"`);
    res.send('﻿' + dong.map((r) => r.map(o).join(',')).join('\r\n') + '\r\n');
  });

  return router;
};
