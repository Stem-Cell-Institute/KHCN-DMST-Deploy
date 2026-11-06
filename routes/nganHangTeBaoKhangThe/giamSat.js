'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — GIÁM SÁT thiết bị: nhật ký nhiệt độ (và mức nitơ lỏng với bình LN) và cảnh báo khi ra ngoài khoảng cho phép.
 * 6 endpoint, chỉ ở thiết bị GỐC. Nghiệp vụ thuần: services/nganHangTeBaoKhangTheNhietDo.js. Bảng nhm_nhiet_do (chỉ thêm), nhm_canh_bao_nhiet.
 *
 * Ai ghi số đo: quản lý module, chủ thiết bị, và — ở thiết bị Public — mọi người dùng module (số đo ghi tên người, không sửa / xóa được).
 * Thiết bị có đơn vị quản lý (Cellbank…): quản lý module và người duyệt của đơn vị. Cấu hình theo dõi và ghi nhận xử lý cảnh báo: người quản lý thiết bị.
 * Số đo ra ngoài khoảng mở MỘT cảnh báo cho thiết bị (nếu đang theo dõi) và báo quản lý ngay; cảnh báo chỉ đóng khi người có quyền ghi rõ đã xử lý gì.
 */

const express = require('express');
const { toInt, toStr } = require('../../services/nganHangTeBaoKhangThe');
const ND = require('../../services/nganHangTeBaoKhangTheNhietDo');
const NhacViec = require('../../services/nganHangTeBaoKhangTheNhacViec');

const khongDau = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

module.exports = function createGiamSatRouter(ctx) {
  const { db, canManage, audit, fail, nhanNguoi, nguoiDung, thongBao, guiNen, YeuCau } = ctx;
  const router = express.Router();

  const layGoc = (id) =>
    db
      .prepare(
        `SELECT c.*, t.name AS type_name FROM nhm_containers c JOIN nhm_container_types t ON t.id = c.type_id WHERE c.id = ? AND c.deleted_at IS NULL`
      )
      .get(id);
  const laBinhNito = (tb) => khongDau(tb.type_name).includes('nito');

  /** Người quản lý thiết bị này (cài đặt theo dõi, xử lý cảnh báo): quản lý module / chủ thiết bị / người duyệt của đơn vị quản lý thiết bị. */
  function quanLyThietBi(req, tb) {
    if (canManage(req) || ctx.quyenViTri(req, tb.id)) return true;
    if (tb.rieng_user_id == null && tb.quan_ly_boi === 'cellbank' && tb.don_vi_id) {
      const dv = db.prepare('SELECT * FROM nhm_don_vi WHERE id = ?').get(tb.don_vi_id);
      return YeuCau.nguoiDuyetDonVi(db, dv).some((u) => u.id === req.user.id);
    }
    return false;
  }
  /** Được ghi số đo: người quản lý thiết bị, hoặc bất kỳ ai ở thiết bị Public. */
  const duocGhi = (req, tb) => quanLyThietBi(req, tb) || (tb.rieng_user_id == null && tb.quan_ly_boi !== 'cellbank');

  /** Chỉ thiết bị gốc: trả thiết bị hoặc null (đã trả lỗi). */
  function layThietBi(req, res) {
    const id = toInt(req.params.id);
    const tb = id && layGoc(id);
    if (!tb) { fail(res, 404, 'Không tìm thấy thiết bị.'); return null; }
    if (tb.parent_id != null) { fail(res, 400, 'Nhiệt độ chỉ ghi cho thiết bị gốc (tủ, bình), không ghi cho ngăn hay Rack.'); return null; }
    if (tb.ngan_hang !== req.nganHang) { fail(res, 404, 'Không tìm thấy thiết bị.'); return null; }
    return tb;
  }

  /** Người nhận báo động của thiết bị: chủ thiết bị riêng, hoặc quản lý ngân hàng + người tạo thiết bị. */
  function nguoiNhanBao(tb) {
    if (tb.rieng_user_id != null) return [YeuCau.nguoiConHoatDong(db, tb.rieng_user_id)].filter(Boolean);
    return [...YeuCau.quanLyModule(db, tb.ngan_hang), YeuCau.nguoiConHoatDong(db, tb.created_by)].filter(Boolean);
  }

  function dinhDangCanhBao(w) {
    return { id: w.id, container_id: w.container_id, nhiet_do: w.nhiet_do, nguong_duoi: w.nguong_duoi, nguong_tren: w.nguong_tren, trang_thai: w.trang_thai, created_at: w.created_at, xu_ly_ten: w.xu_ly_ten, xu_ly_luc: w.xu_ly_luc, ly_do_xu_ly: w.ly_do_xu_ly };
  }

  router.get('/containers/:id/temperatures', (req, res) => {
    const tb = layThietBi(req, res);
    if (!tb) return;
    const ngay = Math.min(365, Math.max(1, toInt(req.query.days) || 30));
    const soDo = db
      .prepare('SELECT id, nhiet_do, muc_nito, ghi_chu, ngoai_nguong, user_label, ghi_luc FROM nhm_nhiet_do WHERE container_id = ? AND ghi_luc >= datetime(\'now\', ?) ORDER BY ghi_luc, id LIMIT 1000')
      .all(tb.id, `-${ngay} days`);
    const cuoi = db.prepare('SELECT id, nhiet_do, muc_nito, ngoai_nguong, user_label, ghi_luc FROM nhm_nhiet_do WHERE container_id = ? ORDER BY ghi_luc DESC, id DESC LIMIT 1').get(tb.id) || null;
    const cb = db.prepare("SELECT * FROM nhm_canh_bao_nhiet WHERE container_id = ? AND trang_thai = 'mo'").get(tb.id);
    const ck = NhacViec.layChuKy(db);
    const moc = cuoi ? cuoi.ghi_luc : tb.updated_at;
    res.json({
      thiet_bi: { id: tb.id, name: tb.name, temperature_c: tb.temperature_c, la_binh_nito: laBinhNito(tb) },
      theo_doi: tb.theo_doi_nhiet === 1,
      nguong: ND.nguongHieuLuc(tb),
      so_do: soDo,
      moi_nhat: cuoi,
      canh_bao: cb ? dinhDangCanhBao(cb) : null,
      chu_ky_ghi_ngay: ck.NHIET_GHI_NGAY,
      qua_han_ghi: tb.theo_doi_nhiet === 1 && moc <= YeuCau.bayGio(Date.now() - ck.NHIET_GHI_NGAY * 86400000),
      quyen_ghi: duocGhi(req, tb),
      quyen_cai_dat: quanLyThietBi(req, tb),
    });
  });

  router.post('/containers/:id/temperatures', (req, res) => {
    const tb = layThietBi(req, res);
    if (!tb) return;
    if (!duocGhi(req, tb)) return fail(res, 403, 'Thiết bị này do đơn vị quản lý: chỉ quản lý module và người duyệt của đơn vị ghi được số đo.');
    const [so, loi] = ND.docSoDo(req.body || {}, laBinhNito(tb));
    if (loi) return fail(res, 400, loi);
    const nguong = ND.nguongHieuLuc(tb);
    const ngoai = ND.ngoaiNguong(so.nhiet_do, nguong);
    let canhBaoMoi = null;
    const id = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO nhm_nhiet_do (container_id, nhiet_do, muc_nito, ghi_chu, ngoai_nguong, user_id, user_label) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(tb.id, so.nhiet_do, so.muc_nito, so.ghi_chu, ngoai ? 1 : 0, req.user.id, nhanNguoi(req.user.id));
      // đang theo dõi mà ra ngoài khoảng: mở cảnh báo nếu chưa có (mỗi thiết bị tối đa một cảnh báo mở)
      if (ngoai && tb.theo_doi_nhiet === 1 && !db.prepare("SELECT 1 FROM nhm_canh_bao_nhiet WHERE container_id = ? AND trang_thai = 'mo'").get(tb.id)) {
        const w = db
          .prepare('INSERT INTO nhm_canh_bao_nhiet (container_id, nhiet_do_id, nhiet_do, nguong_duoi, nguong_tren) VALUES (?, ?, ?, ?, ?)')
          .run(tb.id, info.lastInsertRowid, so.nhiet_do, nguong.duoi, nguong.tren);
        canhBaoMoi = Number(w.lastInsertRowid);
      }
      return Number(info.lastInsertRowid);
    })();
    audit(req, 'temp_log', `${tb.name}: ${so.nhiet_do}°C${so.muc_nito != null ? `, nitơ ${so.muc_nito}` : ''}${ngoai ? ' (NGOÀI KHOẢNG)' : ''}${canhBaoMoi ? ` → cảnh báo #${canhBaoMoi}` : ''}`);
    if (canhBaoMoi) guiNen(thongBao.canhBaoNhiet({ tb, soDo: so, nguong, nguoiGhi: nguoiDung(req.user.id), nguoiNhan: nguoiNhanBao(tb) }));
    res.status(201).json({ id, ngoai_nguong: ngoai, canh_bao_id: canhBaoMoi });
  });

  // Bật / tắt theo dõi và đặt khoảng cho phép (trống = dùng gợi ý theo nhiệt độ chuẩn)
  router.put('/containers/:id/monitoring', (req, res) => {
    const tb = layThietBi(req, res);
    if (!tb) return;
    if (!quanLyThietBi(req, tb)) return fail(res, 403, 'Chỉ Admin, Quản lý module hoặc người quản lý thiết bị mới đổi được cài đặt theo dõi.');
    const [cd, loi] = ND.docCaiDat(req.body || {});
    if (!cd) return fail(res, 400, loi);
    const hieuLuc = ND.nguongHieuLuc({ temperature_c: tb.temperature_c, nguong_duoi: cd.nguong_duoi, nguong_tren: cd.nguong_tren });
    if (cd.theo_doi && hieuLuc.duoi == null && hieuLuc.tren == null) return fail(res, 400, 'Thiết bị chưa có nhiệt độ chuẩn: hãy nhập khoảng nhiệt độ cho phép để theo dõi.');
    const truoc = ND.nguongHieuLuc(tb);
    // bật theo dõi: dùng ngày bật làm mốc «chưa ghi» nên cập nhật updated_at
    db.prepare("UPDATE nhm_containers SET theo_doi_nhiet = ?, nguong_duoi = ?, nguong_tren = ?, updated_at = CASE WHEN theo_doi_nhiet <> ? THEN datetime('now') ELSE updated_at END WHERE id = ?")
      .run(cd.theo_doi, cd.nguong_duoi, cd.nguong_tren, cd.theo_doi, tb.id);
    audit(req, 'monitoring_update', `${tb.name}: theo dõi ${tb.theo_doi_nhiet ? 'bật' : 'tắt'} → ${cd.theo_doi ? 'bật' : 'tắt'}; khoảng ${truoc.duoi}…${truoc.tren} → ${hieuLuc.duoi}…${hieuLuc.tren}°C`);
    res.json({ ok: true, theo_doi: cd.theo_doi === 1, nguong: hieuLuc });
  });

  // ── cảnh báo ──
  router.get('/alarms', (req, res) => {
    const an = ctx.tapAn(req).containers;
    const rows = db
      .prepare(
        `SELECT w.*, c.name AS tb_ten FROM nhm_canh_bao_nhiet w JOIN nhm_containers c ON c.id = w.container_id
         WHERE c.ngan_hang = ? AND c.deleted_at IS NULL ${req.query.status === 'all' ? '' : "AND w.trang_thai = 'mo'"} ORDER BY w.id DESC LIMIT 200`
      )
      .all(req.nganHang)
      .filter((w) => !an.has(w.container_id));
    res.json({ alarms: rows.map((w) => ({ ...dinhDangCanhBao(w), thiet_bi_ten: w.tb_ten })) });
  });

  router.post('/alarms/:id/resolve', (req, res) => {
    const id = toInt(req.params.id);
    const w = id && db.prepare('SELECT * FROM nhm_canh_bao_nhiet WHERE id = ?').get(id);
    const tb = w && layGoc(w.container_id);
    if (!w || !tb || tb.ngan_hang !== req.nganHang || ctx.tapAn(req).containers.has(tb.id)) return fail(res, 404, 'Không tìm thấy cảnh báo.');
    if (w.trang_thai !== 'mo') return fail(res, 409, 'Cảnh báo này đã được ghi nhận xử lý.');
    if (!quanLyThietBi(req, tb)) return fail(res, 403, 'Chỉ Admin, Quản lý module hoặc người quản lý thiết bị mới ghi nhận xử lý cảnh báo.');
    const lyDo = toStr((req.body || {}).ly_do, 500);
    if (!lyDo || lyDo.length < 5) return fail(res, 400, 'Hãy ghi đã xử lý thế nào (nguyên nhân, việc đã làm, mẫu có chuyển đi không), ít nhất 5 ký tự.');
    db.prepare("UPDATE nhm_canh_bao_nhiet SET trang_thai = 'da_xu_ly', xu_ly_boi = ?, xu_ly_ten = ?, xu_ly_luc = datetime('now'), ly_do_xu_ly = ? WHERE id = ?")
      .run(req.user.id, nhanNguoi(req.user.id), lyDo, id);
    audit(req, 'alarm_resolve', `#${id} ${tb.name} (${w.nhiet_do}°C): ${lyDo}`);
    res.json({ ok: true });
  });

  return router;
};
