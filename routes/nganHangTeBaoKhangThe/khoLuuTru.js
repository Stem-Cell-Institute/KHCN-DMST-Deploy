'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — danh mục, cây kho, vị trí lưu trữ (tủ/ngăn/giá) và hộp. 9 endpoint.
 * Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 */

const express = require('express');
const TB = require('../../services/nganHangTeBaoKhangTheThietBi');
const {
  HOLDING, NGAN_HANG, LOAI_CHU_VN, toInt, toStr, parseSo, placeholders, isUniqueError, layThayDoi, moTaThayDoi,
} = require('../../services/nganHangTeBaoKhangThe');

module.exports = function createKhoLuuTruRouter(ctx) {
  const { db, laAdmin, canManage, canEditTube, quyenViTri, laVienTruong, tapAn, audit, fail, subtreeIds, duongDan, activeTubeCountInBoxes, nextCode, logMove } = ctx;
  const router = express.Router();

  // ---------- Danh mục & cây ----------

  router.get('/meta', (req, res) => {
    res.json({
      canManage: canManage(req),
      laVienTruong: laVienTruong(req), // được tạo thiết bị riêng
      isAdmin: laAdmin(req),
      han: ctx.YeuCau.layHan(db),
      loaiChu: LOAI_CHU_VN,
      containerTypes: db.prepare('SELECT * FROM nhm_container_types ORDER BY sort_order, name').all(),
      boxTemplates: db.prepare('SELECT * FROM nhm_box_templates ORDER BY rows, cols, name').all(),
      nganHang: req.nganHang,
      nganHangTen: NGAN_HANG[req.nganHang],
      donVi: db.prepare("SELECT id, ten FROM nhm_don_vi WHERE ngan_hang = ? ORDER BY (ma IN ('cellbank','antibodybank')) DESC, ten").all(req.nganHang), // đơn vị quản lý thiết bị của ngân hàng này (chỉ tên)
      khongPublic: req.nganHang === 'khang_the', // ngân hàng kháng thể: mọi thiết bị thuộc AntibodyBank, không có Public / thiết bị riêng
      sampleTypes: db.prepare('SELECT * FROM nhm_sample_types ORDER BY name').all(),
      mauThietBi: TB.MAU_THIET_BI, // danh mục mẫu thiết bị (bình nitơ lỏng, tủ âm sâu, tủ nằm ngang, tủ lạnh 2 ngăn…), dùng ở form thêm thiết bị và để vẽ sơ đồ
      nhomThietBi: TB.NHOM,
    });
  });

  router.get('/tree', (req, res) => {
    const containers = db
      .prepare(
        `SELECT c.id, c.parent_id, c.type_id, c.code, c.name, c.temperature_c, c.location_note, c.sort_order, c.notes, c.quan_ly_boi, c.don_vi_id, c.vi_tri, c.rieng_user_id, c.created_by, c.mau_tb,
                t.name AS type_name
         FROM nhm_containers c JOIN nhm_container_types t ON t.id = c.type_id
         WHERE c.deleted_at IS NULL ORDER BY c.sort_order, c.name`
      )
      .all();
    const boxes = db
      .prepare(
        `SELECT b.id, b.container_id, b.template_id, b.rows, b.cols, b.code, b.name, b.notes, b.vi_tri,
                (SELECT COUNT(*) FROM nhm_tubes x
                  WHERE x.box_id = b.id AND x.deleted_at IS NULL AND x.status IN ${HOLDING}) AS tube_count
         FROM nhm_boxes b WHERE b.deleted_at IS NULL ORDER BY b.code`
      )
      .all();
    // thiết bị riêng của người khác: bỏ khỏi cây hoàn toàn (kể cả vị trí con và hộp)
    const an = tapAn(req);
    for (let i = containers.length - 1; i >= 0; i--) if (an.containers.has(containers[i].id)) containers.splice(i, 1);
    for (let i = boxes.length - 1; i >= 0; i--) if (an.boxes.has(boxes[i].id)) boxes.splice(i, 1);
    // vị trí con thừa hưởng quan_ly_boi và đơn vị quản lý của thiết bị gốc
    const donVi = new Map(db.prepare('SELECT * FROM nhm_don_vi').all().map((r) => [r.id, r]));
    const donViCuaToi = new Set([...donVi.values()].filter((d) => ctx.YeuCau.nguoiDuyetDonVi(db, d).some((u) => u.id === req.user.id)).map((d) => d.id));
    const byId = new Map(containers.map((c) => [c.id, c]));
    const goc = (c) => {
      for (let i = 0; c.parent_id != null && byId.has(c.parent_id) && i < 50; i++) c = byId.get(c.parent_id);
      return c;
    };
    for (const c of containers) {
      const g = goc(c);
      c.quan_ly_boi = g.quan_ly_boi;
      c.don_vi_id = g.don_vi_id || null;
      const dv = g.don_vi_id ? donVi.get(g.don_vi_id) : null;
      c.don_vi_ten = dv ? dv.ten : null;
      c.don_vi_duyet = dv ? ctx.YeuCau.nhanNguoiDuyet(dv) : null; // ai duyệt yêu cầu lấy mẫu ở thiết bị này
      c.duoc_don_vi = !!dv && donViCuaToi.has(dv.id); // tôi là người duyệt của đơn vị này
      c.rieng = g.rieng_user_id != null; // thiết bị riêng (chỉ chủ và admin tới được đây)
      c.rieng_cua_toi = g.rieng_user_id === req.user.id;
      // được thêm / sửa / xóa ở thiết bị này: quản lý module, chủ thiết bị riêng, hoặc Viện trưởng đã tạo thiết bị
      c.quan_ly_duoc = canManage(req) || g.rieng_user_id === req.user.id || (g.created_by === req.user.id && laVienTruong(req));
    }
    for (const c of containers) {
      delete c.rieng_user_id; // không đưa id người khác ra giao diện
      delete c.created_by;
    }
    res.json({ containers, boxes });
  });

  // ---------- Vị trí lưu trữ ----------

  /** Trả [giá trị, lỗi]; lỗi là câu báo 400 hoặc null. */
  function readContainerBody(body, partial) {
    const out = {};
    let error = null;
    if (!partial || 'name' in body) out.name = toStr(body.name, 200);
    if (!partial || 'type_id' in body) out.type_id = toInt(body.type_id);
    if ('parent_id' in body) out.parent_id = body.parent_id == null || body.parent_id === '' ? null : toInt(body.parent_id);
    if ('code' in body) out.code = toStr(body.code, 60);
    if ('temperature_c' in body) {
      const r = parseSo(body.temperature_c, { min: -273, max: 100, label: 'Nhiệt độ' });
      if (r.error) error = r.error;
      else out.temperature_c = r.value;
    }
    if ('location_note' in body) out.location_note = toStr(body.location_note, 300);
    if ('notes' in body) out.notes = toStr(body.notes, 2000);
    if ('vi_tri' in body) {
      out.vi_tri = body.vi_tri == null || body.vi_tri === '' ? null : toInt(body.vi_tri);
      if (out.vi_tri != null && (out.vi_tri < 1 || out.vi_tri > 50)) error = 'Vị trí số phải từ 1 đến 50.';
    }
    if ('quan_ly_boi' in body) {
      if (!['cong_khai', 'cellbank'].includes(body.quan_ly_boi)) error = 'Kiểu quản lý thiết bị không hợp lệ (công khai hoặc Cellbank).';
      else out.quan_ly_boi = body.quan_ly_boi;
    }
    // Đơn vị quản lý: chọn đơn vị thì thiết bị thành «có đơn vị» (quan_ly_boi = 'cellbank', tên cũ), bỏ chọn thì Public.
    if ('don_vi_id' in body) {
      if (body.don_vi_id == null || body.don_vi_id === '') {
        out.don_vi_id = null;
        out.quan_ly_boi = 'cong_khai';
      } else {
        const dv = toInt(body.don_vi_id);
        if (!dv || !db.prepare('SELECT 1 FROM nhm_don_vi WHERE id = ?').get(dv)) error = 'Đơn vị quản lý không tồn tại.';
        else {
          out.don_vi_id = dv;
          out.quan_ly_boi = 'cellbank';
        }
      }
    } else if ('quan_ly_boi' in out) {
      // cách gọi cũ (chỉ gửi quan_ly_boi): 'cellbank' → đơn vị Cellbank
      const cb = out.quan_ly_boi === 'cellbank' ? db.prepare("SELECT id FROM nhm_don_vi WHERE ma = 'cellbank'").get() : null;
      out.don_vi_id = cb ? cb.id : null;
    }
    if ('sort_order' in body) {
      out.sort_order = body.sort_order == null || body.sort_order === '' ? 0 : toInt(body.sort_order);
      if (out.sort_order == null) error = 'Thứ tự sắp xếp phải là số nguyên.';
    }
    return [out, error];
  }

  /** Vị trí số đã có giá / hộp khác trong cùng vị trí cha chưa? (bỏ qua chính `boQua`) */
  const trungViTriGia = (chaId, viTri, boQua) =>
    viTri != null && !!db.prepare('SELECT 1 FROM nhm_containers WHERE parent_id IS ? AND vi_tri = ? AND id <> ? AND deleted_at IS NULL').get(chaId, viTri, boQua || 0);
  const trungViTriHop = (containerId, viTri, boQua) =>
    viTri != null && !!db.prepare('SELECT 1 FROM nhm_boxes WHERE container_id = ? AND vi_tri = ? AND id <> ? AND deleted_at IS NULL').get(containerId, viTri, boQua || 0);

  /** Đơn vị AntibodyBank: đơn vị quản lý duy nhất của ngân hàng kháng thể. */
  const donViKhangThe = () => (db.prepare("SELECT id FROM nhm_don_vi WHERE ngan_hang = 'khang_the' ORDER BY (ma = 'antibodybank') DESC, id LIMIT 1").get() || {}).id || null;
  const LOI_KHONG_PUBLIC = 'Ngân hàng kháng thể không có Public hay thiết bị riêng: mọi thiết bị thuộc AntibodyBank.';

  /** Id loại vật chứa theo tên; chưa có thì tạo (mẫu thiết bị cần các loại «Tủ âm sâu -86°C», «Giỏ», «Kệ»…). */
  function layHoacTaoLoai(ten, nhietDo) {
    const r = db.prepare('SELECT id FROM nhm_container_types WHERE name = ?').get(ten);
    if (r) return r.id;
    return Number(db.prepare('INSERT INTO nhm_container_types (name, default_temp_c, sort_order) VALUES (?, ?, ?)').run(ten, nhietDo, 50 + db.prepare('SELECT COUNT(*) AS c FROM nhm_container_types').get().c).lastInsertRowid);
  }

  const LOI_QUYEN = 'Chỉ Admin, Quản lý module hoặc chủ thiết bị riêng mới có quyền thao tác này.';
  const khongCoQuyen = (req) => !canManage(req) && !laVienTruong(req);

  router.post('/containers', (req, res) => {
    const body = req.body || {};
    const rieng = body.rieng === true;
    const cha = body.parent_id == null || body.parent_id === '' ? null : toInt(body.parent_id);
    if (rieng && cha != null) return fail(res, 400, 'Chỉ thiết bị gốc mới là thiết bị riêng.');
    if (cha != null) {
      if (!quyenViTri(req, cha)) return fail(res, 403, LOI_QUYEN);
    } else if (rieng) {
      if (!laVienTruong(req)) return fail(res, 403, 'Chỉ Viện trưởng mới tạo được thiết bị riêng.');
    } else if (!canManage(req)) {
      return fail(res, 403, 'Chỉ Admin hoặc Quản lý module mới có quyền thao tác này.');
    }
    const [b, loi] = readContainerBody(body, false);
    if (loi) return fail(res, 400, loi);
    if (rieng) {
      // thiết bị riêng: không công khai, không gắn đơn vị; chủ = người tạo
      b.quan_ly_boi = 'cong_khai';
      b.don_vi_id = null;
      b.rieng_user_id = req.user.id;
    }
    // thiết bị mới thuộc ngân hàng đang dùng; vị trí con theo thiết bị gốc
    b.ngan_hang = cha != null ? (ctx.YeuCau.gocCuaViTri(db, cha) || {}).ngan_hang || req.nganHang : req.nganHang;
    if (b.parent_id == null && b.ngan_hang === 'khang_the') {
      if (rieng) return fail(res, 400, LOI_KHONG_PUBLIC);
      if (b.don_vi_id == null) { b.don_vi_id = donViKhangThe(); b.quan_ly_boi = 'cellbank'; } // thiết bị mới luôn thuộc AntibodyBank
    }
    if (b.don_vi_id != null) {
      const dv = db.prepare('SELECT ngan_hang FROM nhm_don_vi WHERE id = ?').get(b.don_vi_id);
      if (!dv || dv.ngan_hang !== b.ngan_hang) return fail(res, 400, 'Đơn vị quản lý không thuộc ngân hàng này.');
    }
    // chọn MẪU THIẾT BỊ (chỉ thiết bị gốc): loại thiết bị và nhiệt độ theo mẫu; các ngăn của mẫu được tạo kèm (người dùng thêm Rack / giỏ / hộp vào sau)
    let mau = null;
    if (body.mau_tb != null && body.mau_tb !== '') {
      if (b.parent_id != null) return fail(res, 400, 'Chỉ thiết bị gốc mới chọn được mẫu thiết bị.');
      mau = TB.layMau(body.mau_tb);
      if (!mau) return fail(res, 400, 'Mẫu thiết bị không hợp lệ.');
      b.type_id = null; // loại thiết bị của mẫu được lấy / tạo trong transaction bên dưới (không tạo loại rác khi yêu cầu bị từ chối)
      if (!('temperature_c' in body)) b.temperature_c = mau.nhiet_do;
    }
    if (!b.name) return fail(res, 400, 'Thiếu tên vị trí lưu trữ.');
    if (!mau && (b.type_id == null || !db.prepare('SELECT 1 FROM nhm_container_types WHERE id = ?').get(b.type_id))) {
      return fail(res, 400, 'Loại vị trí lưu trữ không hợp lệ.');
    }
    if (b.parent_id != null && !db.prepare('SELECT 1 FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(b.parent_id)) {
      return fail(res, 400, 'Vị trí lưu trữ cha không tồn tại.');
    }
    if (b.parent_id != null && 'quan_ly_boi' in b) return fail(res, 400, 'Chỉ thiết bị gốc mới chọn được kiểu quản lý; vị trí con thừa hưởng từ thiết bị gốc.');
    if (trungViTriGia(b.parent_id ?? null, b.vi_tri ?? null)) return fail(res, 409, `Vị trí số ${b.vi_tri} đã có Rack khác trong vị trí này.`);
    try {
      const code = b.code || nextCode('nhm_containers', 'VC-');
      const ghiGoc = db
        .prepare(
          `INSERT INTO nhm_containers (parent_id, type_id, code, name, temperature_c, location_note, sort_order, notes, quan_ly_boi, don_vi_id, vi_tri, rieng_user_id, ngan_hang, created_by, mau_tb)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
      let soNgan = 0;
      const info = db.transaction(() => {
        const typeId = mau ? layHoacTaoLoai(mau.loai_goc, mau.nhiet_do) : b.type_id;
        const i = ghiGoc.run(b.parent_id ?? null, typeId, code, b.name, b.temperature_c ?? null, b.location_note ?? null, b.sort_order || 0, b.notes ?? null, b.quan_ly_boi || 'cong_khai', b.don_vi_id ?? null, b.vi_tri ?? null, b.rieng_user_id ?? null, b.ngan_hang, req.user.id, mau ? mau.ma : null);
        // các ngăn (khoang) của mẫu: loại «Ngăn», đánh số vị trí 1.. theo thứ tự trong mẫu, nhiệt độ riêng của ngăn nếu mẫu khai
        if (mau && mau.khoang.length) {
          const loaiNgan = layHoacTaoLoai('Ngăn', null);
          const ghiNgan = db.prepare(`INSERT INTO nhm_containers (parent_id, type_id, code, name, temperature_c, sort_order, quan_ly_boi, vi_tri, ngan_hang, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          mau.khoang.forEach((k, idx) => {
            layHoacTaoLoai(k.loai_ke, null); // loại của Rack / giỏ / ngăn kéo / kệ có sẵn để chọn khi thêm vào ngăn
            ghiNgan.run(i.lastInsertRowid, loaiNgan, nextCode('nhm_containers', 'VC-'), k.ten, k.nhiet_do != null ? k.nhiet_do : b.temperature_c ?? null, idx + 1, b.quan_ly_boi || 'cong_khai', idx + 1, b.ngan_hang, req.user.id);
            soNgan++;
          });
        }
        return i;
      })();
      audit(req, 'container_create', `id=${info.lastInsertRowid} ${b.name}${mau ? ' — mẫu ' + mau.ma + ', ' + soNgan + ' ngăn' : ''}`);
      res.status(201).json({ id: Number(info.lastInsertRowid), code, so_ngan: soNgan });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Mã vị trí lưu trữ đã tồn tại.');
      throw e;
    }
  });

  router.patch('/containers/:id', (req, res) => {
    if (khongCoQuyen(req)) return fail(res, 403, 'Chỉ Admin hoặc Quản lý module mới có quyền thao tác này.');
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT * FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy vị trí lưu trữ.');
    if (!quyenViTri(req, id)) return fail(res, 403, LOI_QUYEN);
    const body = req.body || {};
    const [b, loi] = readContainerBody(body, true);
    if (loi) return fail(res, 400, loi);
    if (cur.parent_id == null && cur.ngan_hang === 'khang_the' && (body.rieng === true || ('don_vi_id' in b && b.don_vi_id == null) || b.quan_ly_boi === 'cong_khai')) {
      return fail(res, 400, LOI_KHONG_PUBLIC);
    }
    if (b.don_vi_id != null) {
      const dv = db.prepare('SELECT ngan_hang FROM nhm_don_vi WHERE id = ?').get(b.don_vi_id);
      const nhThietBi = (ctx.YeuCau.gocCuaViTri(db, id) || {}).ngan_hang;
      if (!dv || dv.ngan_hang !== nhThietBi) return fail(res, 400, 'Đơn vị quản lý không thuộc ngân hàng này.');
    }
    // chuyển Public / đơn vị ⇄ riêng: chỉ ở thiết bị gốc; đặt thành riêng chỉ Viện trưởng và chỉ với thiết bị do chính mình tạo / đang là của mình
    if ('rieng' in body) {
      if (cur.parent_id != null) return fail(res, 400, 'Chỉ thiết bị gốc mới là thiết bị riêng.');
      if (body.rieng === true) {
        if (!laVienTruong(req) || !(cur.rieng_user_id === req.user.id || cur.created_by === req.user.id)) {
          return fail(res, 403, 'Chỉ Viện trưởng đặt được thiết bị do chính mình tạo thành thiết bị riêng.');
        }
        b.rieng_user_id = req.user.id;
        b.quan_ly_boi = 'cong_khai';
        b.don_vi_id = null;
      } else if (cur.rieng_user_id != null) {
        b.rieng_user_id = null; // bỏ riêng: thành Public, hoặc theo đơn vị nếu body có don_vi_id
      }
    }
    if ('name' in b && !b.name) return fail(res, 400, 'Tên vị trí lưu trữ không được để trống.');
    if ('type_id' in b && (b.type_id == null || !db.prepare('SELECT 1 FROM nhm_container_types WHERE id = ?').get(b.type_id))) {
      return fail(res, 400, 'Loại vị trí lưu trữ không hợp lệ.');
    }
    if ('parent_id' in b && b.parent_id != null) {
      if (!db.prepare('SELECT 1 FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(b.parent_id)) {
        return fail(res, 400, 'Vị trí lưu trữ cha không tồn tại.');
      }
      if (subtreeIds(id).includes(b.parent_id)) return fail(res, 400, 'Không thể chuyển vị trí lưu trữ vào chính nó hoặc vị trí lưu trữ con.');
    }
    if ('code' in b && !b.code) return fail(res, 400, 'Mã vị trí lưu trữ không được để trống.');
    const chaMoi = 'parent_id' in b ? b.parent_id : cur.parent_id;
    if ('quan_ly_boi' in b && chaMoi != null) return fail(res, 400, 'Chỉ thiết bị gốc mới chọn được kiểu quản lý; vị trí con thừa hưởng từ thiết bị gốc.');
    if (!Object.keys(b).length) return fail(res, 400, 'Không có dữ liệu cần cập nhật.');
    if (('vi_tri' in b || 'parent_id' in b) && trungViTriGia(chaMoi, 'vi_tri' in b ? b.vi_tri : cur.vi_tri, id)) {
      return fail(res, 409, `Vị trí số ${'vi_tri' in b ? b.vi_tri : cur.vi_tri} đã có Rack khác trong vị trí này.`);
    }
    const thayDoi = layThayDoi(cur, b);
    const cols = Object.keys(thayDoi);
    if (!cols.length) return res.json({ ok: true, changed: 0 });
    try {
      db.prepare(`UPDATE nhm_containers SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
        ...cols.map((c) => b[c]),
        id
      );
      // người đang chờ duyệt ở thiết bị này có thể phải đổi cấp (Public ⇄ có đơn vị)
      if ((thayDoi.don_vi_id || thayDoi.quan_ly_boi || thayDoi.rieng_user_id) && ctx.dinhTuyenLai) ctx.dinhTuyenLai();
      const hienThi = { ...thayDoi };
      if (hienThi.don_vi_id) {
        const ten = (v) => (v ? (db.prepare('SELECT ten FROM nhm_don_vi WHERE id = ?').get(v) || {}).ten || v : 'Public');
        hienThi.don_vi_id = hienThi.don_vi_id.map(ten);
      }
      if (hienThi.rieng_user_id) hienThi.rieng_user_id = hienThi.rieng_user_id.map((v) => (v ? 'riêng' : 'không riêng'));
      audit(req, 'container_update', `id=${id} ${cur.name}: ${moTaThayDoi(hienThi)}`);
      res.json({ ok: true, changed: cols.length });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Mã vị trí lưu trữ đã tồn tại.');
      throw e;
    }
  });

  router.delete('/containers/:id', (req, res) => {
    if (khongCoQuyen(req)) return fail(res, 403, 'Chỉ Admin hoặc Quản lý module mới có quyền thao tác này.');
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT id, name FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy vị trí lưu trữ.');
    if (!quyenViTri(req, id)) return fail(res, 403, LOI_QUYEN);
    const ids = subtreeIds(id);
    const boxIds = db
      .prepare(`SELECT id FROM nhm_boxes WHERE deleted_at IS NULL AND container_id IN (${placeholders(ids.length)})`)
      .all(...ids)
      .map((r) => r.id);
    const tubes = activeTubeCountInBoxes(boxIds);
    if (tubes > 0) {
      return fail(res, 409, `Không thể xóa: còn ${tubes} mẫu bên trong. Hãy chuyển hoặc xóa các mẫu trước.`);
    }
    db.transaction(() => {
      db.prepare(`UPDATE nhm_containers SET deleted_at = datetime('now') WHERE id IN (${placeholders(ids.length)})`).run(...ids);
      if (boxIds.length) {
        db.prepare(`UPDATE nhm_boxes SET deleted_at = datetime('now') WHERE id IN (${placeholders(boxIds.length)})`).run(...boxIds);
      }
    })();
    audit(req, 'container_delete', `id=${id} ${cur.name} (${ids.length} vị trí lưu trữ, ${boxIds.length} hộp)`);
    res.json({ ok: true, containers: ids.length, boxes: boxIds.length });
  });

  // ---------- Hộp ----------

  router.post('/boxes', (req, res) => {
    if (khongCoQuyen(req)) return fail(res, 403, 'Chỉ Admin hoặc Quản lý module mới có quyền thao tác này.');
    const body = req.body || {};
    const containerId = toInt(body.container_id);
    if (!containerId || !db.prepare('SELECT 1 FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(containerId)) {
      return fail(res, 400, 'Vị trí lưu trữ không tồn tại.');
    }
    if (!quyenViTri(req, containerId)) return fail(res, 403, LOI_QUYEN);
    let rows = toInt(body.rows);
    let cols = toInt(body.cols);
    const templateId = body.template_id == null || body.template_id === '' ? null : toInt(body.template_id);
    if (templateId != null) {
      const t = db.prepare('SELECT rows, cols FROM nhm_box_templates WHERE id = ?').get(templateId);
      if (!t) return fail(res, 400, 'Mẫu hộp không tồn tại.');
      rows = t.rows;
      cols = t.cols;
    }
    if (!rows || !cols || rows < 1 || rows > 26 || cols < 1 || cols > 30) {
      return fail(res, 400, 'Kích thước hộp không hợp lệ (1–26 hàng, 1–30 cột).');
    }
    const count = body.count == null ? 1 : toInt(body.count);
    if (!count || count < 1 || count > 50) return fail(res, 400, 'Số lượng hộp phải từ 1 đến 50.');
    // khai vị trí số trong giá (bình nitơ): mỗi lần một hộp, không trùng vị trí đã có
    const viTri = body.vi_tri == null || body.vi_tri === '' ? null : toInt(body.vi_tri);
    if (body.vi_tri != null && body.vi_tri !== '' && (viTri == null || viTri < 1 || viTri > 50)) return fail(res, 400, 'Vị trí hộp trong Rack phải là số từ 1 đến 50.');
    if (viTri != null && count > 1) return fail(res, 400, 'Khai vị trí số thì thêm từng hộp một.');
    if (trungViTriHop(containerId, viTri)) return fail(res, 409, `Vị trí số ${viTri} trong Rack này đã có hộp.`);
    const baseName = toStr(body.name, 150);
    const customCode = toStr(body.code, 60);
    if (customCode && count > 1) return fail(res, 400, 'Không đặt mã tùy chỉnh khi tạo nhiều hộp cùng lúc.');
    try {
      const created = db.transaction(() => {
        const ids = [];
        for (let i = 0; i < count; i++) {
          const code = customCode || nextCode('nhm_boxes', 'HOP-');
          const name = baseName ? (count > 1 ? `${baseName} ${i + 1}` : baseName) : null;
          const info = db
            .prepare(
              `INSERT INTO nhm_boxes (container_id, template_id, rows, cols, code, name, notes, vi_tri, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(containerId, templateId, rows, cols, code, name, toStr(body.notes, 2000), viTri, req.user.id);
          ids.push(Number(info.lastInsertRowid));
        }
        return ids;
      })();
      audit(req, 'box_create', `container=${containerId} ids=${created.join(',')}`);
      res.status(201).json({ ids: created });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Mã hộp đã tồn tại.');
      throw e;
    }
  });

  router.get('/boxes/:id', (req, res) => {
    const id = toInt(req.params.id);
    const box = id && db.prepare('SELECT * FROM nhm_boxes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!box) return fail(res, 404, 'Không tìm thấy hộp.');
    const path = duongDan(box.container_id);
    const tubes = db
      .prepare(
        `SELECT t.id, t.row_no, t.col_no, t.name, t.passage, t.cell_count, t.volume_ml, t.the_tich_ul, t.con_lai_ul, t.chu_don_vi, t.lo_id, lo.ma AS lo_ma, dtb.id AS dong_id, dtb.ten AS dong_ten, t.freeze_date,
                t.project, t.status, t.notes, t.owner_user_id, t.box_id, t.sample_type_id, s.name AS sample_type_name,
                t.chu_loai, t.nhom_id, (SELECT ten FROM nhm_nhom WHERE id = t.nhom_id) AS nhom_ten,
                CASE WHEN t.chu_don_vi = 1 THEN COALESCE((SELECT ten FROM nhm_don_vi WHERE ma = 'antibodybank'), 'AntibodyBank') ELSE (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = t.owner_user_id) END AS owner_name
         FROM nhm_tubes t LEFT JOIN nhm_sample_types s ON s.id = t.sample_type_id
         LEFT JOIN nhm_lo lo ON lo.id = t.lo_id LEFT JOIN nhm_dong_te_bao dtb ON dtb.id = lo.dong_id
         WHERE t.box_id = ? AND t.deleted_at IS NULL AND t.status IN ${HOLDING}`
      )
      .all(id);
    const nghiMat = new Map(
      db.prepare("SELECT tube_id, id FROM nhm_vu_viec WHERE trang_thai IN ('mo','cho_chu_xac_nhan')").all().map((r) => [r.tube_id, r.id])
    );
    const phatHien = db
      .prepare("SELECT id, row_no, col_no, mo_ta, nhac_lan FROM nhm_phat_hien WHERE box_id = ? AND trang_thai = 'cho_chu_mau'")
      .all(id);
    res.json({
      box,
      path,
      tubes: tubes.map((t) => ({ ...t, can_edit: canEditTube(req, t), nghi_mat: nghiMat.has(t.id), vu_viec_id: nghiMat.get(t.id) || null })),
      phat_hien: phatHien,
      quan_ly_boi: (ctx.YeuCau.thietBiGocCuaHop(db, id) || {}).quan_ly_boi || 'cong_khai',
      don_vi_ten: (ctx.YeuCau.donViCuaHop(db, id) || {}).ten || null,
      don_vi_duyet: ctx.YeuCau.nhanNguoiDuyet(ctx.YeuCau.donViCuaHop(db, id)),
      rieng_cua_toi: ctx.chuRiengCuaViTri(box.container_id) === req.user.id, // tôi là chủ thiết bị riêng chứa hộp này
      quan_ly_duoc: quyenViTri(req, box.container_id), // được thêm / sửa / xóa ở thiết bị chứa hộp này
      duoc_don_vi: ctx.quanLyDonVi(req, id), // người duyệt của đơn vị: không bị chặn thêm / lấy mẫu ở thiết bị của đơn vị mình
    });
  });

  router.patch('/boxes/:id', (req, res) => {
    if (khongCoQuyen(req)) return fail(res, 403, 'Chỉ Admin hoặc Quản lý module mới có quyền thao tác này.');
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT * FROM nhm_boxes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy hộp.');
    if (!quyenViTri(req, cur.container_id)) return fail(res, 403, LOI_QUYEN);
    const body = req.body || {};
    const upd = {};
    if ('name' in body) upd.name = toStr(body.name, 150);
    if ('notes' in body) upd.notes = toStr(body.notes, 2000);
    if ('code' in body) {
      upd.code = toStr(body.code, 60);
      if (!upd.code) return fail(res, 400, 'Mã hộp không được để trống.');
    }
    if ('vi_tri' in body) {
      upd.vi_tri = body.vi_tri == null || body.vi_tri === '' ? null : toInt(body.vi_tri);
      if (upd.vi_tri != null && (upd.vi_tri < 1 || upd.vi_tri > 50)) return fail(res, 400, 'Vị trí hộp trong Rack phải là số từ 1 đến 50.');
    }
    if ('container_id' in body) {
      const cid = toInt(body.container_id);
      if (!cid || !db.prepare('SELECT 1 FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(cid)) {
        return fail(res, 400, 'Vị trí lưu trữ không tồn tại.');
      }
      if (!quyenViTri(req, cid)) return fail(res, 403, LOI_QUYEN);
      upd.container_id = cid;
    }
    if ('rows' in body || 'cols' in body) {
      const rows = 'rows' in body ? toInt(body.rows) : cur.rows;
      const cols = 'cols' in body ? toInt(body.cols) : cur.cols;
      if (!rows || !cols || rows < 1 || rows > 26 || cols < 1 || cols > 30) return fail(res, 400, 'Kích thước hộp không hợp lệ.');
      const outside = db
        .prepare(
          `SELECT COUNT(*) AS c FROM nhm_tubes
           WHERE box_id = ? AND deleted_at IS NULL AND status IN ${HOLDING} AND (row_no > ? OR col_no > ?)`
        )
        .get(id, rows, cols).c;
      if (outside > 0) return fail(res, 409, `Không thể thu nhỏ hộp: ${outside} mẫu nằm ngoài kích thước mới.`);
      upd.rows = rows;
      upd.cols = cols;
      // Kích thước không còn khớp mẫu hộp đã chọn thì bỏ liên kết mẫu, để template_id không nói sai.
      if (cur.template_id != null) {
        const tpl = db.prepare('SELECT rows, cols FROM nhm_box_templates WHERE id = ?').get(cur.template_id);
        if (!tpl || tpl.rows !== rows || tpl.cols !== cols) upd.template_id = null;
      }
    }
    if (!Object.keys(upd).length) return fail(res, 400, 'Không có dữ liệu cần cập nhật.');
    const cidMoi = 'container_id' in upd ? upd.container_id : cur.container_id;
    const viTriMoi = 'vi_tri' in upd ? upd.vi_tri : cur.vi_tri;
    if (('vi_tri' in upd || 'container_id' in upd) && trungViTriHop(cidMoi, viTriMoi, id)) return fail(res, 409, `Vị trí số ${viTriMoi} trong Rack này đã có hộp.`);
    const thayDoi = layThayDoi(cur, upd);
    const cols = Object.keys(thayDoi);
    if (!cols.length) return res.json({ ok: true, changed: 0 });
    try {
      db.transaction(() => {
        db.prepare(`UPDATE nhm_boxes SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
          ...cols.map((c) => upd[c]),
          id
        );
        // Hộp đổi chỗ hoặc đổi mã: ghi vào lịch sử của từng mẫu đang nằm trong hộp, để xem lịch sử mẫu
        // vẫn biết mẫu đã theo hộp sang tủ khác.
        const moi = { ...cur, ...upd };
        let note = null;
        let action = null;
        if (thayDoi.container_id) {
          action = 'box_move';
          note = `Hộp ${moi.code}: ${duongDan(cur.container_id).join(' › ')} → ${duongDan(upd.container_id).join(' › ')}`;
        } else if (thayDoi.code) {
          action = 'box_edit';
          note = `Mã hộp: ${cur.code} → ${moi.code}`;
        }
        if (action) {
          const tubes = db
            .prepare(`SELECT id FROM nhm_tubes WHERE box_id = ? AND deleted_at IS NULL AND status IN ${HOLDING}`)
            .all(id);
          for (const t of tubes) logMove(t.id, action, null, null, req.user.id, note);
        }
      })();
      const hienThi = { ...thayDoi };
      if (hienThi.container_id) hienThi.container_id = hienThi.container_id.map((v) => duongDan(v).join(' › '));
      audit(req, 'box_update', `id=${id} ${cur.code}: ${moTaThayDoi(hienThi)}`);
      res.json({ ok: true, changed: cols.length });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Mã hộp đã tồn tại.');
      throw e;
    }
  });

  router.delete('/boxes/:id', (req, res) => {
    if (khongCoQuyen(req)) return fail(res, 403, 'Chỉ Admin hoặc Quản lý module mới có quyền thao tác này.');
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT id, code, container_id FROM nhm_boxes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy hộp.');
    if (!quyenViTri(req, cur.container_id)) return fail(res, 403, LOI_QUYEN);
    const tubes = activeTubeCountInBoxes([id]);
    if (tubes > 0) return fail(res, 409, `Không thể xóa: hộp còn ${tubes} mẫu.`);
    db.prepare("UPDATE nhm_boxes SET deleted_at = datetime('now') WHERE id = ?").run(id);
    audit(req, 'box_delete', `id=${id} ${cur.code}`);
    res.json({ ok: true });
  });

  return router;
};
