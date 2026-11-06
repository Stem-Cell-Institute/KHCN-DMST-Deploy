'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — việc ĐẾN HẠN cần quản lý chủ động làm, và thư nhắc định kỳ.
 * Hàm thuần theo `db` (router và bộ hẹn giờ dùng chung). Router: routes/nganHangTeBaoKhangThe/nhacViec.js.
 *
 * Năm loại việc:
 *   kiem_ke         thiết bị có hộp (đang chứa mẫu) quá chu kỳ kiểm kê mà chưa kiểm kê
 *   myco            dòng tế bào còn ống đang lưu nhưng chưa thử mycoplasma, hoặc lần thử gần nhất quá chu kỳ
 *   myco_duong_tinh dòng còn ống đang lưu mà lần thử mycoplasma gần nhất DƯƠNG TÍNH
 *   str             dòng còn ống đang lưu nhưng chưa xác thực STR, hoặc lần gần nhất quá chu kỳ
 *   nhiet_quen      thiết bị đang theo dõi nhiệt độ nhưng quá số ngày chưa có số đo
 *   nhiet_canh_bao  cảnh báo nhiệt độ đang mở (số đo ra ngoài khoảng cho phép) chưa ghi nhận xử lý
 *
 * Chu kỳ chỉnh được ở Quản lý module → Cấu hình hạn (bảng nhm_cau_hinh, đọc qua layChuKy). QC chỉ có ở ngân hàng tế bào.
 * Thư nhắc gộp theo người nhận, mỗi việc nhắc lại sau NHAC_LAI_NGAY ngày (nhm_nhac_viec); việc xong thì dòng nhớ bị xóa.
 */

const { HOLDING, NGAN_HANG } = require('./nganHangTeBaoKhangThe');
const { quanLyModule, nguoiConHoatDong, bayGio } = require('./nganHangTeBaoKhangTheYeuCau');

const CHU_KY_MAC_DINH = { KIEM_KE_NGAY: 180, MYCO_NGAY: 180, STR_NGAY: 365, NHIET_GHI_NGAY: 3, NHAC_LAI_NGAY: 7 };
const GIOI_HAN_CHU_KY = { KIEM_KE_NGAY: [30, 730], MYCO_NGAY: [30, 730], STR_NGAY: [90, 1095], NHIET_GHI_NGAY: [1, 14], NHAC_LAI_NGAY: [1, 30] };
const KHOA_CHU_KY = {
  KIEM_KE_NGAY: 'chu_ky_kiem_ke_ngay',
  MYCO_NGAY: 'chu_ky_myco_ngay',
  STR_NGAY: 'chu_ky_str_ngay',
  NHIET_GHI_NGAY: 'chu_ky_nhiet_ghi_ngay',
  NHAC_LAI_NGAY: 'chu_ky_nhac_lai_ngay',
};
const NHAN_CHU_KY = {
  KIEM_KE_NGAY: 'Chu kỳ kiểm kê hộp (quá chu kỳ thì nhắc kiểm kê)',
  MYCO_NGAY: 'Chu kỳ thử mycoplasma của dòng tế bào',
  STR_NGAY: 'Chu kỳ xác thực STR của dòng tế bào',
  NHIET_GHI_NGAY: 'Quá số ngày này chưa ghi nhiệt độ thì nhắc (thiết bị đang theo dõi)',
  NHAC_LAI_NGAY: 'Việc vẫn chưa làm thì nhắc lại qua email sau mỗi',
};
/** Dòng mới tạo mà chưa có kết quả QC nào: cho thời gian này trước khi coi là «chưa thử» (tránh nhắc ngay khi vừa lập hồ sơ). */
const DONG_MOI_NGAY = 30;

/** Các chu kỳ đang áp dụng: mặc định, đè bằng giá trị quản lý đã lưu (giá trị hỏng hoặc ngoài khoảng thì bỏ qua). */
function layChuKy(db) {
  const out = { ...CHU_KY_MAC_DINH };
  let rows = [];
  try {
    rows = db.prepare('SELECT key, value FROM nhm_cau_hinh').all();
  } catch (e) {
    return out;
  }
  for (const k of Object.keys(KHOA_CHU_KY)) {
    const r = rows.find((x) => x.key === KHOA_CHU_KY[k]);
    const n = r ? Number(r.value) : NaN;
    const [min, max] = GIOI_HAN_CHU_KY[k];
    if (Number.isInteger(n) && n >= min && n <= max) out[k] = n;
  }
  return out;
}

function luuChuKy(db, giaTri, userId) {
  const up = db.prepare(
    "INSERT INTO nhm_cau_hinh (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now')) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at'
  );
  db.transaction(() => {
    for (const k of Object.keys(giaTri)) up.run(KHOA_CHU_KY[k], String(giaTri[k]), userId || null);
  })();
}

// thiết bị RIÊNG của Viện trưởng (kể cả cấp con cháu): chỉ chủ và admin thấy, nên việc của thiết bị đó chỉ nhắc chủ
const CTE_RIENG = 'WITH RECURSIVE rieng(id) AS (SELECT id FROM nhm_containers WHERE rieng_user_id IS NOT NULL UNION SELECT c.id FROM nhm_containers c JOIN rieng r ON c.parent_id = r.id)';

// 'YYYY-MM-DD' hoặc 'YYYY-MM-DD HH:MM:SS' (UTC) → mili giây
const mocMs = (s) => (String(s).length <= 10 ? new Date(s + 'T00:00:00Z') : new Date(String(s).replace(' ', 'T') + 'Z')).getTime();
const soNgayTu = (s, ms) => Math.floor((ms - mocMs(s)) / 86400000);
const ngayVn = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');

/**
 * Mọi việc đến hạn của một ngân hàng tại thời điểm `ms`. Mỗi việc:
 * { loai, khoa, muc: 'do'|'vang', tieu_de, chi_tiet, doi_tuong: {loai: 'container'|'dong', id}, container_id?, rieng_user_id, nguoi_tao_id }
 * `khoa` ổn định theo (loại, đối tượng) để chống gửi trùng thư. Chưa lọc theo người xem (router lọc thiết bị riêng).
 */
function tinhViecDenHan(db, nganHang, ms = Date.now()) {
  const ck = layChuKy(db);
  const ngay = (n) => bayGio(ms - n * 86400000);
  const viec = [];

  // ── kiểm kê: hộp có mẫu lưu kho mà lần kiểm kê gần nhất (hoặc ngày tạo hộp nếu chưa kiểm) đã quá chu kỳ ──
  const kk = db
    .prepare(
      `WITH RECURSIVE g(id, goc) AS (
         SELECT id, id FROM nhm_containers WHERE parent_id IS NULL AND deleted_at IS NULL AND ngan_hang = ?
         UNION ALL SELECT c.id, g.goc FROM nhm_containers c JOIN g ON c.parent_id = g.id WHERE c.deleted_at IS NULL)
       SELECT r.id AS goc_id, r.name, r.rieng_user_id, r.created_by, COUNT(b.id) AS so_hop,
              SUM(CASE WHEN COALESCE(b.kiem_ke_luc, b.created_at) <= ? THEN 1 ELSE 0 END) AS so_den_han,
              SUM(CASE WHEN b.kiem_ke_luc IS NULL AND b.created_at <= ? THEN 1 ELSE 0 END) AS chua_tung,
              MIN(COALESCE(b.kiem_ke_luc, b.created_at)) AS cu_nhat
       FROM g JOIN nhm_containers r ON r.id = g.goc
              JOIN nhm_boxes b ON b.container_id = g.id AND b.deleted_at IS NULL
                 AND EXISTS (SELECT 1 FROM nhm_tubes t WHERE t.box_id = b.id AND t.deleted_at IS NULL AND t.status = 'in_storage')
       GROUP BY r.id HAVING so_den_han > 0 ORDER BY cu_nhat`
    )
    .all(nganHang, ngay(ck.KIEM_KE_NGAY), ngay(ck.KIEM_KE_NGAY));
  for (const r of kk) {
    viec.push({
      loai: 'kiem_ke', khoa: `kiem_ke:${r.goc_id}`, muc: 'vang',
      tieu_de: `Đến hạn kiểm kê: ${r.name}`,
      chi_tiet: `${r.so_den_han}/${r.so_hop} hộp quá ${ck.KIEM_KE_NGAY} ngày chưa kiểm kê${r.chua_tung ? ` (${r.chua_tung} hộp chưa kiểm lần nào)` : ''}; lâu nhất từ ${ngayVn(r.cu_nhat)}.`,
      doi_tuong: { loai: 'container', id: r.goc_id }, container_id: r.goc_id, rieng_user_id: r.rieng_user_id, nguoi_tao_id: r.created_by,
    });
  }

  // ── QC của dòng tế bào (chỉ ngân hàng tế bào): chỉ tính dòng còn ống đang lưu ở thiết bị không riêng ──
  if (nganHang === 'te_bao') {
    const dong = db
      .prepare(
        `${CTE_RIENG}
         SELECT d.id, d.ma, d.ten, d.created_by, d.created_at,
                (SELECT COUNT(*) FROM nhm_tubes t JOIN nhm_lo l ON l.id = t.lo_id
                   WHERE l.dong_id = d.id AND t.deleted_at IS NULL AND t.status IN ${HOLDING}
                     AND (t.box_id IS NULL OR t.box_id NOT IN (SELECT b.id FROM nhm_boxes b WHERE b.container_id IN (SELECT id FROM rieng)))) AS so_ong
         FROM nhm_dong_te_bao d WHERE d.deleted_at IS NULL`
      )
      .all()
      .filter((d) => d.so_ong > 0);
    const gan = db.prepare('SELECT ket_qua, ngay FROM nhm_qc WHERE dong_id = ? AND loai = ? ORDER BY ngay DESC, id DESC LIMIT 1');
    for (const d of dong) {
      const ten = `${d.ma} · ${d.ten}`;
      const doiTuong = { loai: 'dong', id: d.id };
      const co = { rieng_user_id: null, nguoi_tao_id: d.created_by };
      const myco = gan.get(d.id, 'mycoplasma');
      if (myco && myco.ket_qua === 'duong_tinh') {
        viec.push({ loai: 'myco_duong_tinh', khoa: `myco_duong_tinh:${d.id}`, muc: 'do', tieu_de: `Mycoplasma DƯƠNG TÍNH: ${ten}`,
          chi_tiet: `Lần thử ${ngayVn(myco.ngay)} dương tính, còn ${d.so_ong} ống đang lưu. Cách ly, xử lý hoặc loại bỏ dòng; thử lại sau xử lý.`, doi_tuong: doiTuong, ...co });
      } else if (!myco) {
        if (soNgayTu(d.created_at, ms) >= DONG_MOI_NGAY) {
          viec.push({ loai: 'myco', khoa: `myco:${d.id}`, muc: 'vang', tieu_de: `Chưa thử mycoplasma: ${ten}`,
            chi_tiet: `Dòng có ${d.so_ong} ống đang lưu nhưng chưa có kết quả mycoplasma nào.`, doi_tuong: doiTuong, ...co });
        }
      } else if (soNgayTu(myco.ngay, ms) > ck.MYCO_NGAY) {
        viec.push({ loai: 'myco', khoa: `myco:${d.id}`, muc: 'vang', tieu_de: `Quá hạn thử mycoplasma: ${ten}`,
          chi_tiet: `Lần thử gần nhất ${ngayVn(myco.ngay)} (${soNgayTu(myco.ngay, ms)} ngày trước, chu kỳ ${ck.MYCO_NGAY} ngày); còn ${d.so_ong} ống đang lưu.`, doi_tuong: doiTuong, ...co });
      }
      const str = gan.get(d.id, 'str');
      if (!str) {
        if (soNgayTu(d.created_at, ms) >= DONG_MOI_NGAY) {
          viec.push({ loai: 'str', khoa: `str:${d.id}`, muc: 'vang', tieu_de: `Chưa xác thực STR: ${ten}`,
            chi_tiet: `Dòng có ${d.so_ong} ống đang lưu nhưng chưa có kết quả xác thực STR.`, doi_tuong: doiTuong, ...co });
        }
      } else if (soNgayTu(str.ngay, ms) > ck.STR_NGAY) {
        viec.push({ loai: 'str', khoa: `str:${d.id}`, muc: 'vang', tieu_de: `Quá hạn xác thực STR: ${ten}`,
          chi_tiet: `Lần gần nhất ${ngayVn(str.ngay)} (${soNgayTu(str.ngay, ms)} ngày trước, chu kỳ ${ck.STR_NGAY} ngày).`, doi_tuong: doiTuong, ...co });
      }
    }
  }

  // ── nhiệt độ: thiết bị đang theo dõi mà quên ghi, và cảnh báo đang mở ──
  const tb = db
    .prepare(
      `SELECT c.id, c.name, c.rieng_user_id, c.created_by, c.updated_at,
              (SELECT MAX(ghi_luc) FROM nhm_nhiet_do n WHERE n.container_id = c.id) AS cuoi
       FROM nhm_containers c WHERE c.parent_id IS NULL AND c.deleted_at IS NULL AND c.ngan_hang = ? AND c.theo_doi_nhiet = 1`
    )
    .all(nganHang);
  for (const c of tb) {
    const moc = c.cuoi || c.updated_at;
    if (moc <= ngay(ck.NHIET_GHI_NGAY)) {
      viec.push({
        loai: 'nhiet_quen', khoa: `nhiet_quen:${c.id}`, muc: 'vang', tieu_de: `Chưa ghi nhiệt độ: ${c.name}`,
        chi_tiet: c.cuoi ? `Số đo gần nhất ${ngayVn(c.cuoi)}, đã quá ${ck.NHIET_GHI_NGAY} ngày.` : `Chưa có số đo nào kể từ khi bật theo dõi (${ngayVn(c.updated_at)}).`,
        doi_tuong: { loai: 'container', id: c.id }, container_id: c.id, rieng_user_id: c.rieng_user_id, nguoi_tao_id: c.created_by,
      });
    }
  }
  const cb = db
    .prepare(
      `SELECT w.id, w.container_id, w.nhiet_do, w.nguong_duoi, w.nguong_tren, w.created_at, c.name, c.rieng_user_id, c.created_by
       FROM nhm_canh_bao_nhiet w JOIN nhm_containers c ON c.id = w.container_id
       WHERE w.trang_thai = 'mo' AND c.deleted_at IS NULL AND c.ngan_hang = ?`
    )
    .all(nganHang);
  for (const w of cb) {
    const khoang = w.nguong_duoi != null || w.nguong_tren != null ? ` (cho phép ${w.nguong_duoi != null ? w.nguong_duoi : '…'} đến ${w.nguong_tren != null ? w.nguong_tren : '…'}°C)` : '';
    viec.push({
      loai: 'nhiet_canh_bao', khoa: `nhiet_canh_bao:${w.id}`, muc: 'do', tieu_de: `Cảnh báo nhiệt độ: ${w.name}`,
      chi_tiet: `Số đo ${String(w.nhiet_do).replace('.', ',')}°C ngày ${ngayVn(w.created_at)}${khoang}. Kiểm tra thiết bị, chuyển mẫu nếu cần rồi ghi nhận đã xử lý.`,
      doi_tuong: { loai: 'container', id: w.container_id }, container_id: w.container_id, canh_bao_id: w.id, rieng_user_id: w.rieng_user_id, nguoi_tao_id: w.created_by,
    });
  }
  return viec;
}

/** Người nhận thư nhắc của một việc: quản lý ngân hàng (thiết bị riêng thì chỉ chủ), cộng người tạo dòng / thiết bị. */
function nguoiNhanCua(db, nganHang, v, quanLy) {
  const ds = new Map();
  const them = (u) => u && ds.set(u.id, u);
  if (v.rieng_user_id != null) them(nguoiConHoatDong(db, v.rieng_user_id));
  else {
    for (const u of quanLy) them(u);
    them(nguoiConHoatDong(db, v.nguoi_tao_id));
  }
  return [...ds.values()];
}

/**
 * Gửi thư nhắc các việc đến hạn (gộp một thư cho mỗi người), bỏ qua việc vừa nhắc trong NHAC_LAI_NGAY ngày.
 * `thongBao.nhacViec({nguoiNhan, viec, nganHang})` gửi thư (không ném lỗi). Trả {viec, nguoi}.
 */
async function quetNhacViec(db, thongBao, ms = Date.now()) {
  const ck = layChuKy(db);
  const tong = { viec: 0, nguoi: 0 };
  for (const nh of Object.keys(NGAN_HANG)) {
    const viec = tinhViecDenHan(db, nh, ms);
    // việc đã xong (không còn trong danh sách) thì quên, để lần sau tái phát được nhắc ngay
    const khoaHienTai = new Set(viec.map((v) => `${nh}:${v.khoa}`));
    for (const r of db.prepare('SELECT khoa FROM nhm_nhac_viec WHERE khoa LIKE ?').all(`${nh}:%`)) {
      if (!khoaHienTai.has(r.khoa)) db.prepare('DELETE FROM nhm_nhac_viec WHERE khoa = ?').run(r.khoa);
    }
    const ngung = bayGio(ms - ck.NHAC_LAI_NGAY * 86400000);
    const cho = viec.filter((v) => {
      const r = db.prepare('SELECT lan_cuoi FROM nhm_nhac_viec WHERE khoa = ?').get(`${nh}:${v.khoa}`);
      return !r || r.lan_cuoi <= ngung;
    });
    if (!cho.length) continue;
    const quanLy = quanLyModule(db, nh);
    const theoNguoi = new Map();
    for (const v of cho) {
      for (const u of nguoiNhanCua(db, nh, v, quanLy)) {
        if (!theoNguoi.has(u.id)) theoNguoi.set(u.id, { nguoi: u, viec: [] });
        theoNguoi.get(u.id).viec.push(v);
      }
    }
    // đánh dấu đã nhắc TRƯỚC khi gửi: SMTP hỏng thì lần quét sau (30 phút) không gửi dồn lại; việc vẫn hiện trong «Đến hạn»
    const luu = db.prepare("INSERT INTO nhm_nhac_viec (khoa, lan_cuoi, so_lan) VALUES (?, ?, 1) ON CONFLICT(khoa) DO UPDATE SET lan_cuoi = excluded.lan_cuoi, so_lan = so_lan + 1");
    db.transaction(() => cho.forEach((v) => luu.run(`${nh}:${v.khoa}`, bayGio(ms))))();
    for (const { nguoi, viec: ds } of theoNguoi.values()) {
      await thongBao.nhacViec({ nguoiNhan: nguoi, viec: ds, nganHang: nh });
      tong.nguoi++;
    }
    tong.viec += cho.length;
  }
  return tong;
}

module.exports = { CHU_KY_MAC_DINH, GIOI_HAN_CHU_KY, KHOA_CHU_KY, NHAN_CHU_KY, DONG_MOI_NGAY, layChuKy, luuChuKy, tinhViecDenHan, nguoiNhanCua, quetNhacViec };
