'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — hồ sơ DÒNG TẾ BÀO (thông tin sinh học, nuôi cấy, an toàn sinh học), lô (stock), kết quả QC và
 * báo cáo GMO / an toàn sinh học. 12 endpoint. Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js). Tệp đính kèm: tepDinhKem.js.
 *
 * Chỉ dùng ở ngân hàng TẾ BÀO. Ai có tài khoản module cũng xem và tạo hồ sơ dòng của mình; sửa / xóa dòng, lô, ghi QC: người tạo dòng hoặc quản lý.
 * QC chỉ thêm, không sửa / xóa (trigger). Xóa dòng / lô chỉ khi không còn ống đang giữ. Ống thuộc lô qua nhm_tubes.lo_id (mau.js).
 * Báo cáo GMO (xem, CSV, in A4): chỉ quản lý và Viện trưởng — là danh mục an toàn sinh học nên không mở cho mọi người.
 */

const express = require('express');
const { toInt, toStr, chuanHoaTen, HOLDING } = require('../../services/nganHangTeBaoKhangThe');
const DT = require('../../services/nganHangTeBaoKhangTheDongTeBao');

module.exports = function createDongTeBaoRouter(ctx) {
  const { db, canManage, laVienTruong, audit, fail, nhanNguoi, moTaViTri, dkKhongAn, YeuCau } = ctx;
  const router = express.Router();
  const homNay = () => YeuCau.homNayVn();

  function chiTeBao(req, res) {
    if (req.nganHang !== 'te_bao') { fail(res, 400, 'Hồ sơ dòng tế bào chỉ dùng ở ngân hàng tế bào.'); return false; }
    return true;
  }
  const quyenSua = (req, dong) => canManage(req) || dong.created_by === req.user.id;
  const layDong = (id) => db.prepare('SELECT * FROM nhm_dong_te_bao WHERE id = ? AND deleted_at IS NULL').get(id);

  /** Dòng mà một đối tượng đính kèm (dòng / lô / QC) thuộc về; null nếu không có. Tệp đính kèm dùng để kiểm quyền. */
  ctx.dongCuaDoiTuong = (loai, id) => {
    if (loai === 'dong') return layDong(id) || null;
    const bang = loai === 'lo' ? 'nhm_lo' : loai === 'qc' ? 'nhm_qc' : null;
    const r = bang && db.prepare(`SELECT dong_id FROM ${bang} WHERE id = ?`).get(id);
    return r ? layDong(r.dong_id) || null : null;
  };

  /** Ống đang giữ (lưu kho / đã lấy ra) của dòng hoặc lô mà người này thấy (không tính thiết bị riêng của người khác). */
  function demOng(req, dongId, loId) {
    const dk = loId ? 't.lo_id = ?' : 'l.dong_id = ?';
    return db
      .prepare(
        `SELECT COUNT(*) AS c FROM nhm_tubes t JOIN nhm_lo l ON l.id = t.lo_id
         WHERE ${dk} AND t.deleted_at IS NULL AND t.status IN ${HOLDING} AND ${dkKhongAn(req, 't.box_id')}`
      )
      .get(loId || dongId).c;
  }
  /** Tổng ống đang giữ kể cả thiết bị riêng (để chặn xóa: ống ở thiết bị riêng cũng là ống thật). */
  function demOngThat(dongId, loId) {
    const dk = loId ? 't.lo_id = ?' : 'l.dong_id = ?';
    return db.prepare(`SELECT COUNT(*) AS c FROM nhm_tubes t JOIN nhm_lo l ON l.id = t.lo_id WHERE ${dk} AND t.deleted_at IS NULL AND t.status IN ${HOLDING}`).get(loId || dongId).c;
  }

  function dinhDangDong(req, d) {
    return {
      id: d.id, ma: d.ma, ten: d.ten, loai_sinh_vat: d.loai_sinh_vat, mo_nguon_goc: d.mo_nguon_goc, benh: d.benh, loai_dong: d.loai_dong, dang_nuoi: d.dang_nuoi,
      moi_truong: d.moi_truong, bo_sung: d.bo_sung, nhiet_do_c: d.nhiet_do_c, co2_phan_tram: d.co2_phan_tram, thoi_gian_nhan_doi: d.thoi_gian_nhan_doi,
      hinh_thai: d.hinh_thai, dac_diem_tang_truong: d.dac_diem_tang_truong, nguon_cung_cap: d.nguon_cung_cap, ma_nguon: d.ma_nguon,
      bien_doi_gen: d.bien_doi_gen === 1, gmo_mo_ta: d.gmo_mo_ta, bsl: d.bsl, du_an: d.du_an, nhom_id: d.nhom_id,
      nhom_ten: d.nhom_id ? (db.prepare('SELECT ten FROM nhm_nhom WHERE id = ?').get(d.nhom_id) || {}).ten || null : null,
      ghi_chu: d.ghi_chu, tao_boi_ten: d.created_by ? nhanNguoi(d.created_by) : null, created_at: d.created_at, updated_at: d.updated_at,
      quyen_sua: quyenSua(req, d),
    };
  }

  // ---------- danh sách / chi tiết ----------

  router.get('/cell-lines', (req, res) => {
    if (!chiTeBao(req, res)) return;
    const q = chuanHoaTen(typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '');
    const gmo = req.query.gmo === '1';
    let rows = db.prepare('SELECT * FROM nhm_dong_te_bao WHERE deleted_at IS NULL ORDER BY ten, id').all();
    if (gmo) rows = rows.filter((d) => d.bien_doi_gen === 1);
    if (q) {
      const tu = q.split(' ').filter(Boolean);
      rows = rows.filter((d) => {
        const kho = chuanHoaTen([d.ma, d.ten, d.loai_sinh_vat, d.mo_nguon_goc, d.benh, d.nguon_cung_cap, d.ma_nguon, d.du_an].join(' '));
        return tu.every((t) => kho.includes(t));
      });
    }
    const nay = homNay();
    res.json({
      cell_lines: rows.slice(0, 500).map((d) => ({
        id: d.id, ma: d.ma, ten: d.ten, loai_sinh_vat: d.loai_sinh_vat, mo_nguon_goc: d.mo_nguon_goc, bien_doi_gen: d.bien_doi_gen === 1, bsl: d.bsl,
        so_lo: db.prepare('SELECT COUNT(*) AS c FROM nhm_lo WHERE dong_id = ? AND deleted_at IS NULL').get(d.id).c, so_ong: demOng(req, d.id),
        mycoplasma: DT.trangThaiMyco(db, d.id, nay),
      })),
      tong: rows.length,
    });
  });

  router.post('/cell-lines', (req, res) => {
    if (!chiTeBao(req, res)) return;
    const [d, loi] = DT.docDong(req.body || {}, { tao: true });
    if (loi) return fail(res, 400, loi);
    try {
      const cols = Object.keys(d);
      const info = db.prepare(`INSERT INTO nhm_dong_te_bao (${cols.join(', ')}, created_by) VALUES (${cols.map(() => '?').join(', ')}, ?)`).run(...cols.map((c) => d[c]), req.user.id);
      audit(req, 'cell_line_create', `id=${info.lastInsertRowid} ${d.ma} ${d.ten}${d.bien_doi_gen ? ' (GMO, BSL-' + d.bsl + ')' : ''}`);
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) return fail(res, 409, 'Đã có dòng tế bào dùng mã này.');
      throw e;
    }
  });

  router.get('/cell-lines/:id', (req, res) => {
    if (!chiTeBao(req, res)) return;
    const id = toInt(req.params.id);
    const d = id && layDong(id);
    if (!d) return fail(res, 404, 'Không tìm thấy dòng tế bào.');
    const nay = homNay();
    const lo = db.prepare('SELECT * FROM nhm_lo WHERE dong_id = ? AND deleted_at IS NULL ORDER BY COALESCE(ngay_dong_lanh, \'\') DESC, id DESC').all(id)
      .map((l) => ({ ...l, so_ong: demOng(req, id, l.id) }));
    const qc = db.prepare('SELECT * FROM nhm_qc WHERE dong_id = ? ORDER BY ngay DESC, id DESC').all(id);
    const idLo = lo.map((l) => l.id);
    const idQc = qc.map((x) => x.id);
    const tep = db
      .prepare("SELECT * FROM nhm_tep WHERE xoa_luc IS NULL AND ((doi_tuong = 'dong' AND doi_tuong_id = ?) OR (doi_tuong = 'lo') OR (doi_tuong = 'qc')) ORDER BY id DESC")
      .all(id)
      .filter((t) => t.doi_tuong === 'dong' || (t.doi_tuong === 'lo' ? idLo.includes(t.doi_tuong_id) : idQc.includes(t.doi_tuong_id)))
      .map((t) => ({ id: t.id, doi_tuong: t.doi_tuong, doi_tuong_id: t.doi_tuong_id, ten_goc: t.ten_goc, mime: t.mime, kich_thuoc: t.kich_thuoc, mo_ta: t.mo_ta, tao_boi_ten: t.tao_boi_ten, tao_luc: t.tao_luc, anh: /^image\//.test(t.mime) }));
    const ong = db
      .prepare(
        `SELECT t.id, t.name, t.status, t.box_id, t.row_no, t.col_no, t.lo_id, l.ma AS lo_ma FROM nhm_tubes t JOIN nhm_lo l ON l.id = t.lo_id
         WHERE l.dong_id = ? AND t.deleted_at IS NULL AND t.status IN ${HOLDING} AND ${dkKhongAn(req, 't.box_id')} ORDER BY l.ma, t.id LIMIT 300`
      )
      .all(id)
      .map((t) => ({ id: t.id, name: t.name, status: t.status, lo_id: t.lo_id, lo_ma: t.lo_ma, box_id: t.box_id, vi_tri: moTaViTri(t.box_id, t.row_no, t.col_no) }));
    res.json({
      dong: dinhDangDong(req, d), lo, qc: qc.map((x) => ({ ...x, lo_ma: x.lo_id ? (lo.find((l) => l.id === x.lo_id) || {}).ma || null : null })), tep, ong,
      mycoplasma: DT.trangThaiMyco(db, id, nay), han_myco_ngay: DT.HAN_MYCO_NGAY,
    });
  });

  router.patch('/cell-lines/:id', (req, res) => {
    if (!chiTeBao(req, res)) return;
    const id = toInt(req.params.id);
    const cur = id && layDong(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy dòng tế bào.');
    if (!quyenSua(req, cur)) return fail(res, 403, 'Chỉ người tạo dòng hoặc quản lý mới sửa được hồ sơ dòng tế bào.');
    const [d, loi] = DT.docDong(req.body || {}, { tao: false, cur });
    if (loi) return fail(res, 400, loi);
    const cols = Object.keys(d).filter((k) => (cur[k] == null ? null : cur[k]) !== (d[k] == null ? null : d[k]));
    if (!cols.length) return res.json({ ok: true, changed: 0 });
    try {
      db.prepare(`UPDATE nhm_dong_te_bao SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map((c) => d[c]), id);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) return fail(res, 409, 'Đã có dòng tế bào dùng mã này.');
      throw e;
    }
    audit(req, 'cell_line_update', `id=${id} ${cur.ma}: ${cols.map((c) => `${c}: ${cur[c] == null ? '(trống)' : String(cur[c]).slice(0, 60)} → ${d[c] == null ? '(trống)' : String(d[c]).slice(0, 60)}`).join('; ')}`);
    res.json({ ok: true, changed: cols.length });
  });

  router.delete('/cell-lines/:id', (req, res) => {
    if (!chiTeBao(req, res)) return;
    const id = toInt(req.params.id);
    const cur = id && layDong(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy dòng tế bào.');
    if (!quyenSua(req, cur)) return fail(res, 403, 'Chỉ người tạo dòng hoặc quản lý mới xóa được dòng tế bào.');
    const con = demOngThat(id);
    if (con > 0) return fail(res, 409, `Dòng này còn ${con} ống đang giữ trong kho. Hãy chuyển ống sang dòng khác hoặc xử lý ống trước.`);
    db.transaction(() => {
      db.prepare("UPDATE nhm_lo SET deleted_at = datetime('now') WHERE dong_id = ? AND deleted_at IS NULL").run(id);
      db.prepare("UPDATE nhm_dong_te_bao SET deleted_at = datetime('now') WHERE id = ?").run(id);
    })();
    audit(req, 'cell_line_delete', `id=${id} ${cur.ma} ${cur.ten}`);
    res.json({ ok: true });
  });

  // ---------- lô (stock) ----------

  router.post('/cell-lines/:id/lots', (req, res) => {
    if (!chiTeBao(req, res)) return;
    const id = toInt(req.params.id);
    const dong = id && layDong(id);
    if (!dong) return fail(res, 404, 'Không tìm thấy dòng tế bào.');
    if (!quyenSua(req, dong)) return fail(res, 403, 'Chỉ người tạo dòng hoặc quản lý mới thêm được lô.');
    const [l, loi] = DT.docLo(req.body || {}, { tao: true });
    if (loi) return fail(res, 400, loi);
    try {
      const cols = Object.keys(l);
      const info = db.prepare(`INSERT INTO nhm_lo (dong_id, ${cols.join(', ')}, created_by) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`).run(id, ...cols.map((c) => l[c]), req.user.id);
      audit(req, 'cell_lot_create', `id=${info.lastInsertRowid} dòng ${dong.ma} lô ${l.ma}`);
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) return fail(res, 409, 'Dòng này đã có lô dùng mã đó.');
      throw e;
    }
  });

  function layLo(req, res) {
    const id = toInt(req.params.id);
    const lo = id && db.prepare('SELECT * FROM nhm_lo WHERE id = ? AND deleted_at IS NULL').get(id);
    const dong = lo && layDong(lo.dong_id);
    if (!lo || !dong) { fail(res, 404, 'Không tìm thấy lô.'); return null; }
    if (!quyenSua(req, dong)) { fail(res, 403, 'Chỉ người tạo dòng hoặc quản lý mới sửa được lô.'); return null; }
    return { lo, dong };
  }

  router.patch('/lots/:id', (req, res) => {
    if (!chiTeBao(req, res)) return;
    const x = layLo(req, res);
    if (!x) return;
    const [l, loi] = DT.docLo(req.body || {}, { tao: false });
    if (loi) return fail(res, 400, loi);
    const cols = Object.keys(l).filter((k) => (x.lo[k] == null ? null : x.lo[k]) !== (l[k] == null ? null : l[k]));
    if (!cols.length) return res.json({ ok: true, changed: 0 });
    try {
      db.prepare(`UPDATE nhm_lo SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map((c) => l[c]), x.lo.id);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) return fail(res, 409, 'Dòng này đã có lô dùng mã đó.');
      throw e;
    }
    audit(req, 'cell_lot_update', `id=${x.lo.id} dòng ${x.dong.ma} lô ${x.lo.ma}: ${cols.join(', ')}`);
    res.json({ ok: true, changed: cols.length });
  });

  router.delete('/lots/:id', (req, res) => {
    if (!chiTeBao(req, res)) return;
    const x = layLo(req, res);
    if (!x) return;
    const con = demOngThat(x.dong.id, x.lo.id);
    if (con > 0) return fail(res, 409, `Lô này còn ${con} ống đang giữ trong kho. Hãy chuyển ống sang lô khác hoặc xử lý ống trước.`);
    db.prepare("UPDATE nhm_lo SET deleted_at = datetime('now') WHERE id = ?").run(x.lo.id);
    audit(req, 'cell_lot_delete', `id=${x.lo.id} dòng ${x.dong.ma} lô ${x.lo.ma}`);
    res.json({ ok: true });
  });

  // ---------- QC (chỉ thêm) ----------

  router.post('/cell-lines/:id/qc', (req, res) => {
    if (!chiTeBao(req, res)) return;
    const id = toInt(req.params.id);
    const dong = id && layDong(id);
    if (!dong) return fail(res, 404, 'Không tìm thấy dòng tế bào.');
    if (!quyenSua(req, dong)) return fail(res, 403, 'Chỉ người tạo dòng hoặc quản lý mới ghi được kết quả QC.');
    const b = req.body || {};
    const [q, loi] = DT.docQc(b, homNay());
    if (loi) return fail(res, 400, loi);
    let loId = null;
    if (b.lo_id != null && b.lo_id !== '') {
      loId = toInt(b.lo_id);
      if (!loId || !db.prepare('SELECT 1 FROM nhm_lo WHERE id = ? AND dong_id = ? AND deleted_at IS NULL').get(loId, id)) return fail(res, 400, 'Lô không thuộc dòng này.');
    }
    const info = db
      .prepare('INSERT INTO nhm_qc (dong_id, lo_id, loai, ket_qua, ngay, phuong_phap, ghi_chu, user_id, user_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, loId, q.loai, q.ket_qua, q.ngay, q.phuong_phap, q.ghi_chu, req.user.id, nhanNguoi(req.user.id));
    audit(req, 'cell_qc_create', `id=${info.lastInsertRowid} dòng ${dong.ma}: ${q.loai} = ${q.ket_qua} (${q.ngay})`);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  // ---------- báo cáo GMO / an toàn sinh học ----------

  /** 'HH:MM dd/mm/yyyy' giờ Việt Nam, ghi vào chân bản in. */
  function gioInVn() {
    const v = new Date(Date.now() + 7 * 3600000);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(v.getUTCHours())}:${p(v.getUTCMinutes())} ${p(v.getUTCDate())}/${p(v.getUTCMonth() + 1)}/${v.getUTCFullYear()}`;
  }

  function duocXemBaoCao(req, res) {
    if (!chiTeBao(req, res)) return false;
    if (!canManage(req) && !laVienTruong(req)) { fail(res, 403, 'Chỉ Viện trưởng hoặc quản lý mới xem được báo cáo dòng biến đổi gen / an toàn sinh học.'); return false; }
    return true;
  }

  /** Các dòng biến đổi gen (lọc theo BSL và từ khóa), kèm số lô, số ống đang giữ, vị trí, mycoplasma gần nhất; tổng kết. */
  function baoCaoGmo(req) {
    const bsl = req.query.bsl ? toInt(req.query.bsl) : null;
    const q = chuanHoaTen(typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '');
    const nay = homNay();
    let rows = db.prepare('SELECT * FROM nhm_dong_te_bao WHERE deleted_at IS NULL AND bien_doi_gen = 1 ORDER BY bsl DESC, ten, id').all();
    if (bsl) rows = rows.filter((d) => d.bsl === bsl);
    if (q) {
      const tu = q.split(' ').filter(Boolean);
      rows = rows.filter((d) => { const kho = chuanHoaTen([d.ma, d.ten, d.loai_sinh_vat, d.gmo_mo_ta, d.nguon_cung_cap, d.du_an].join(' ')); return tu.every((t) => kho.includes(t)); });
    }
    const dongBao = rows.map((d) => {
      const ong = db
        .prepare(`SELECT t.box_id, t.row_no, t.col_no FROM nhm_tubes t JOIN nhm_lo l ON l.id = t.lo_id WHERE l.dong_id = ? AND t.deleted_at IS NULL AND t.status IN ${HOLDING} AND ${dkKhongAn(req, 't.box_id')} ORDER BY t.id`)
        .all(d.id);
      const vt = [...new Set(ong.map((t) => moTaViTri(t.box_id, t.row_no, t.col_no)).filter(Boolean))];
      const myco = DT.trangThaiMyco(db, d.id, nay);
      const qc = db.prepare('SELECT MAX(ngay) AS n FROM nhm_qc WHERE dong_id = ?').get(d.id).n;
      return {
        ma: d.ma, ten: d.ten, loai_sinh_vat: d.loai_sinh_vat, bsl: d.bsl, bsl_ten: DT.BSL_VN[d.bsl] || '', gmo_mo_ta: d.gmo_mo_ta, nguon_cung_cap: d.nguon_cung_cap, du_an: d.du_an,
        nhom: d.nhom_id ? (db.prepare('SELECT ten FROM nhm_nhom WHERE id = ?').get(d.nhom_id) || {}).ten || '' : '',
        so_lo: db.prepare('SELECT COUNT(*) AS c FROM nhm_lo WHERE dong_id = ? AND deleted_at IS NULL').get(d.id).c, so_ong: ong.length,
        vi_tri: vt.slice(0, 8).join('; ') + (vt.length > 8 ? `; … (+${vt.length - 8})` : ''),
        mycoplasma: myco.co ? `${DT.QC_KET_QUA_VN[myco.ket_qua]} (${myco.ngay})${myco.qua_han ? ' — quá hạn thử' : ''}` : 'Chưa thử',
        qc_gan_nhat: qc || '', nguoi_tao: d.created_by ? nhanNguoi(d.created_by) : '',
      };
    });
    const theoBsl = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const r of dongBao) if (r.bsl) theoBsl[r.bsl]++;
    return { dong: dongBao, tong: { so_dong: dongBao.length, so_ong: dongBao.reduce((a, r) => a + r.so_ong, 0), theo_bsl: theoBsl, chua_thu_mycoplasma: dongBao.filter((r) => r.mycoplasma === 'Chưa thử' || /quá hạn/.test(r.mycoplasma)).length } };
  }

  router.get('/reports/gmo', (req, res) => {
    if (!duocXemBaoCao(req, res)) return;
    res.json(baoCaoGmo(req));
  });

  const COT_CSV = [['ma', 'Mã dòng'], ['ten', 'Tên dòng'], ['loai_sinh_vat', 'Loài'], ['bsl_ten', 'An toàn sinh học'], ['gmo_mo_ta', 'Biến đổi gen'], ['nguon_cung_cap', 'Nguồn cung cấp'],
    ['du_an', 'Đề tài / dự án'], ['nhom', 'Nhóm nghiên cứu'], ['so_lo', 'Số lô'], ['so_ong', 'Số ống đang giữ'], ['vi_tri', 'Vị trí lưu trữ'], ['mycoplasma', 'Mycoplasma gần nhất'], ['qc_gan_nhat', 'QC gần nhất'], ['nguoi_tao', 'Người tạo hồ sơ']];

  router.get('/reports/gmo.csv', (req, res) => {
    if (!duocXemBaoCao(req, res)) return;
    const bc = baoCaoGmo(req);
    audit(req, 'report_gmo_csv', `${bc.tong.so_dong} dòng`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bao-cao-gmo-${homNay().replace(/-/g, '')}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(DT.taoCsv(bc.dong, COT_CSV));
  });

  router.get('/reports/gmo/print', (req, res) => {
    if (!duocXemBaoCao(req, res)) return;
    const bc = baoCaoGmo(req);
    audit(req, 'report_gmo_print', `${bc.tong.so_dong} dòng`);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(DT.dungBaoCaoGmo({ ...bc, loc: { bsl: req.query.bsl ? toInt(req.query.bsl) : null, q: typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '' }, nguoiIn: nhanNguoi(req.user.id), ngay: homNay(), inLuc: gioInVn() }));
  });

  return router;
};
