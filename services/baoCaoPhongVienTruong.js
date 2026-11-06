/**
 * Quyết định của Viện trưởng về TỪNG báo cáo, và việc "trình" một đợt cho Viện trưởng.
 *
 * Nguyên tắc: trạng thái duyệt của Viện trưởng KHÔNG có cột riêng. Nó được suy ra từ chính lịch sử của báo cáo
 * (bcp_lich_su), nơi mỗi quyết định đã là một dòng:
 *     vt_duyet · vt_khong_duyet · vt_de_nghi_chinh_sua
 * Nhờ vậy chỉ có MỘT nguồn sự thật: cái hiện trên báo cáo và cái ghi trong lịch sử không bao giờ lệch nhau.
 *
 * Quyết định chỉ áp dụng cho BẢN NỘP hiện tại. Nó hết hiệu lực khi:
 *   - phòng nộp lại (nop / nop_lai)           → bản mới chưa ai xem
 *   - người quản lý yêu cầu chỉnh sửa (yeu_cau_chinh_sua) → báo cáo bị đưa về sửa, nội dung sắp đổi
 * Riêng "đề nghị chỉnh sửa" của Viện trưởng chính là yêu cầu sửa nên vẫn còn hiệu lực cho đến khi phòng nộp lại.
 * Viện trưởng đổi ý được: quyết định mới ghi nối vào lịch sử và thay quyết định cũ (cũ vẫn còn trong lịch sử).
 *
 * "Trình" (bcp_trinh_lan): người quản lý module bấm trình một đợt → toàn bộ báo cáo của đợt hiện ra trong giao diện
 * Viện trưởng. Không có tệp, không ảnh chụp: báo cáo đã nộp bị khóa nên nội dung đang hiển thị chính là bản đã nộp.
 */

const QUYET_DINH_THEO_HANH_DONG = {
  vt_duyet: 'duyet',
  vt_khong_duyet: 'khong_duyet',
  vt_de_nghi_chinh_sua: 'de_nghi_chinh_sua',
};
const HANH_DONG_THEO_QUYET_DINH = Object.fromEntries(Object.entries(QUYET_DINH_THEO_HANH_DONG).map(([k, v]) => [v, k]));
const QUYET_DINH = Object.keys(HANH_DONG_THEO_QUYET_DINH);
/** Hành động trong lịch sử báo cáo mà việc suy ra quyết định cần đọc. */
const HANH_DONG_LIEN_QUAN = ['nop', 'nop_lai', 'yeu_cau_chinh_sua', ...Object.keys(QUYET_DINH_THEO_HANH_DONG)];

/**
 * Quyết định còn hiệu lực của MỘT báo cáo, từ các dòng lịch sử của nó theo thứ tự id tăng dần.
 * @param {Array<{hanh_dong:string, nguoi?:string, ghi_chu?:string, tao_luc?:string}>} dong
 * @returns {{quyet_dinh:string, ghi_chu:string|null, nguoi:string|null, luc:string|null}|null}
 */
function suyRaQuyetDinh(dong) {
  let hienTai = null;
  for (const d of dong) {
    if (d.hanh_dong === 'nop' || d.hanh_dong === 'nop_lai') hienTai = null;
    else if (d.hanh_dong === 'yeu_cau_chinh_sua') {
      if (hienTai && hienTai.quyet_dinh !== 'de_nghi_chinh_sua') hienTai = null;
    } else if (QUYET_DINH_THEO_HANH_DONG[d.hanh_dong]) {
      hienTai = { quyet_dinh: QUYET_DINH_THEO_HANH_DONG[d.hanh_dong], ghi_chu: d.ghi_chu || null, nguoi: d.nguoi || null, luc: d.tao_luc || null };
    }
  }
  return hienTai;
}

/**
 * Báo cáo đang ở đâu trong con mắt của Viện trưởng:
 *   chua_nop          — phòng chưa nộp (không có gì để duyệt)
 *   dang_sua          — phòng đang chỉnh sửa theo yêu cầu của người quản lý
 *   de_nghi_chinh_sua — Viện trưởng đã đề nghị sửa, chờ phòng nộp lại
 *   cho_quyet_dinh    — đã nộp, Viện trưởng chưa quyết định
 *   duyet · khong_duyet
 */
function trangThaiVienTruong(trangThaiBaoCao, quyetDinh) {
  if (trangThaiBaoCao === 'chua_nop') return 'chua_nop';
  if (trangThaiBaoCao === 'can_chinh_sua') return quyetDinh && quyetDinh.quyet_dinh === 'de_nghi_chinh_sua' ? 'de_nghi_chinh_sua' : 'dang_sua';
  return quyetDinh && quyetDinh.quyet_dinh !== 'de_nghi_chinh_sua' ? quyetDinh.quyet_dinh : 'cho_quyet_dinh';
}

/** Đếm theo trạng thái của Viện trưởng. `cho_quyet_dinh` là việc đang chờ ông; phần còn lại chỉ để thống kê. */
function demTienDo(dsTrangThai) {
  const dem = { tong: dsTrangThai.length, chua_nop: 0, dang_sua: 0, de_nghi_chinh_sua: 0, cho_quyet_dinh: 0, duyet: 0, khong_duyet: 0 };
  for (const t of dsTrangThai) dem[t] += 1;
  dem.da_nop = dem.tong - dem.chua_nop - dem.dang_sua - dem.de_nghi_chinh_sua;
  return dem;
}

function taoVienTruong({ db }) {
  const dsHanhDong = HANH_DONG_LIEN_QUAN.map(() => '?').join(',');

  /** Gom các dòng lịch sử (đã sắp theo id) theo báo cáo rồi suy ra quyết định của từng báo cáo. */
  function suyRaChoNhieu(rows) {
    const theoBaoCao = new Map();
    for (const r of rows) {
      if (!theoBaoCao.has(r.bao_cao_id)) theoBaoCao.set(r.bao_cao_id, []);
      theoBaoCao.get(r.bao_cao_id).push(r);
    }
    const kq = new Map();
    for (const [id, dong] of theoBaoCao) kq.set(id, suyRaQuyetDinh(dong));
    return kq;
  }

  /** Quyết định còn hiệu lực của MỌI báo cáo trong đợt: Map<baoCaoId, quyetDinh|null>. Một truy vấn cho cả đợt. */
  function quyetDinhTheoDot(dotId) {
    return suyRaChoNhieu(
      db
        .prepare(
          `SELECT h.bao_cao_id, h.hanh_dong, h.ghi_chu, h.tao_luc, u.fullname AS nguoi
             FROM bcp_lich_su h
             JOIN bcp_bao_cao b ON b.id = h.bao_cao_id
             LEFT JOIN users u ON u.id = h.nguoi_id
            WHERE b.dot_id = ? AND h.hanh_dong IN (${dsHanhDong})
            ORDER BY h.id`
        )
        .all(dotId, ...HANH_DONG_LIEN_QUAN)
    );
  }

  /** Như quyetDinhTheoDot nhưng cho một danh sách báo cáo bất kỳ (vd. "Báo cáo của tôi", trải qua nhiều đợt). */
  function quyetDinhTheoIds(baoCaoIds) {
    if (!baoCaoIds.length) return new Map();
    return suyRaChoNhieu(
      db
        .prepare(
          `SELECT h.bao_cao_id, h.hanh_dong, h.ghi_chu, h.tao_luc, u.fullname AS nguoi
             FROM bcp_lich_su h LEFT JOIN users u ON u.id = h.nguoi_id
            WHERE h.bao_cao_id IN (${baoCaoIds.map(() => '?').join(',')}) AND h.hanh_dong IN (${dsHanhDong})
            ORDER BY h.id`
        )
        .all(...baoCaoIds, ...HANH_DONG_LIEN_QUAN)
    );
  }

  function quyetDinhMotBaoCao(baoCaoId) {
    const dong = db
      .prepare(
        `SELECT h.hanh_dong, h.ghi_chu, h.tao_luc, u.fullname AS nguoi
           FROM bcp_lich_su h LEFT JOIN users u ON u.id = h.nguoi_id
          WHERE h.bao_cao_id = ? AND h.hanh_dong IN (${dsHanhDong})
          ORDER BY h.id`
      )
      .all(baoCaoId, ...HANH_DONG_LIEN_QUAN);
    return suyRaQuyetDinh(dong);
  }

  /**
   * Ai đã ĐƯA báo cáo về trạng thái cần chỉnh sửa: 'vien_truong' hay 'quan_ly' (để lời nhắn hiện đúng người nói).
   * Lấy theo dòng lịch sử mới nhất trong hai hành động đó.
   */
  function nguoiYeuCauSua(baoCaoIds) {
    const kq = new Map();
    if (!baoCaoIds.length) return kq;
    const rows = db
      .prepare(
        `SELECT bao_cao_id, hanh_dong FROM bcp_lich_su
          WHERE hanh_dong IN ('yeu_cau_chinh_sua','vt_de_nghi_chinh_sua') AND bao_cao_id IN (${baoCaoIds.map(() => '?').join(',')})
          ORDER BY id`
      )
      .all(...baoCaoIds);
    for (const r of rows) kq.set(r.bao_cao_id, r.hanh_dong === 'vt_de_nghi_chinh_sua' ? 'vien_truong' : 'quan_ly');
    return kq;
  }

  /** Lần trình mới nhất của đợt (kèm số lần), hoặc null nếu đợt chưa từng được trình. */
  function trinhCuaDot(dotId) {
    const t = db
      .prepare(
        `SELECT l.id, l.trinh_luc, l.loi_nhan, u.fullname AS nguoi_trinh,
                (SELECT COUNT(*) FROM bcp_trinh_lan x WHERE x.dot_id = l.dot_id) AS lan
           FROM bcp_trinh_lan l LEFT JOIN users u ON u.id = l.nguoi_trinh_id
          WHERE l.dot_id = ? ORDER BY l.id DESC LIMIT 1`
      )
      .get(dotId);
    return t || null;
  }

  /** Tiến độ xử lý của Viện trưởng trong một đợt. */
  function tienDoDot(dotId) {
    const baoCao = db.prepare('SELECT id, trang_thai FROM bcp_bao_cao WHERE dot_id = ?').all(dotId);
    const qd = quyetDinhTheoDot(dotId);
    return demTienDo(baoCao.map((b) => trangThaiVienTruong(b.trang_thai, qd.get(b.id) || null)));
  }

  /**
   * Các đợt đã trình kèm tiến độ xử lý của Viện trưởng.
   *   chiConCho — chỉ đợt còn báo cáo chờ quyết định, cũ nhất trước (thẻ việc, nhãn đếm trên thanh điều hướng)
   *   mặc định  — mọi đợt đã trình, lần trình mới nhất trước, tối đa `gioiHan` (danh sách "Duyệt báo cáo", để xem lại đợt đã xử lý xong)
   */
  function dsDotTrinh({ chiConCho = false, gioiHan = 30 } = {}) {
    const dots = db
      .prepare(
        `SELECT d.id AS dot_id, d.tieu_de, d.ky, d.han_nop, d.trang_thai
           FROM bcp_dot d WHERE d.trang_thai <> 'nhap' AND EXISTS (SELECT 1 FROM bcp_trinh_lan l WHERE l.dot_id = d.id)`
      )
      .all();
    const kq = [];
    for (const d of dots) {
      const td = tienDoDot(d.dot_id);
      if (chiConCho && td.cho_quyet_dinh === 0) continue;
      const t = trinhCuaDot(d.dot_id);
      kq.push({ ...d, trinh_luc: t.trinh_luc, nguoi_trinh: t.nguoi_trinh, loi_nhan: t.loi_nhan, lan: t.lan, ...td });
    }
    const huong = chiConCho ? 1 : -1;
    kq.sort((a, b) => huong * (a.trinh_luc < b.trinh_luc ? -1 : a.trinh_luc > b.trinh_luc ? 1 : a.dot_id - b.dot_id));
    return kq.slice(0, gioiHan);
  }
  const dotChoVienTruong = () => dsDotTrinh({ chiConCho: true, gioiHan: 1000 });

  return { quyetDinhTheoDot, quyetDinhTheoIds, quyetDinhMotBaoCao, nguoiYeuCauSua, trinhCuaDot, tienDoDot, dsDotTrinh, dotChoVienTruong };
}

module.exports = {
  QUYET_DINH,
  HANH_DONG_THEO_QUYET_DINH,
  suyRaQuyetDinh,
  trangThaiVienTruong,
  demTienDo,
  taoVienTruong,
};
