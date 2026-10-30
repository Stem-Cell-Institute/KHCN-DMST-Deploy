/**
 * Tự nhắc trước hạn nộp báo cáo (module Báo cáo phòng ban).
 *
 * Quy tắc:
 *   - Chỉ đợt ĐANG MỞ, chỉ báo cáo CHƯA NỘP hoặc đang CẦN CHỈNH SỬA. Đã nộp / đã duyệt thì không bao giờ nhắc.
 *   - Hai mốc: CÒN 1–2 NGÀY ('truoc_han') và ĐÚNG NGÀY HẠN ('hom_nay'). Mỗi mốc nhắc MỘT lần cho mỗi hạn nộp
 *     (bcp_nhac_han). Dời hạn thì hạn mới được nhắc lại. Quá hạn rồi thì không nhắc nữa (không làm phiền mãi).
 *   - Chỉ gửi trong giờ làm việc theo GIỜ VIỆT NAM (8h–17h59): không gửi thư lúc nửa đêm vì server chạy UTC.
 *   - Dòng nhật ký được giành TRƯỚC khi gửi (INSERT OR IGNORE): chạy chồng hay khởi động lại cũng không nhắc đôi.
 *     Nếu mọi thư đều lỗi (SMTP hỏng) thì nhả dòng ra để lần chạy sau thử lại.
 *   - Một trưởng phòng phụ trách nhiều phòng nhận MỘT thư.
 */

const GIO_BAT_DAU = 8;
const GIO_KET_THUC = 18; // gửi khi giờ < 18
const NHAC_TRUOC_NGAY = 2;
const CHU_KY_MS = 30 * 60 * 1000;
const TRE_BAN_DAU_MS = 2 * 60 * 1000;

const vn = (ms) => new Date(ms + 7 * 3600 * 1000);

function taoNhacHan({ db, thongBao, chuKyMs = CHU_KY_MS }) {
  let dangChay = false;

  /** Chạy một lượt. `ms` (mili-giây) để test điều khiển được thời gian. Không bao giờ ném lỗi. */
  async function chayMotLan(ms = Date.now()) {
    const kq = { nhac: 0, gui: 0, bo_qua: null };
    if (dangChay) return { ...kq, bo_qua: 'dang_chay' };
    const gio = vn(ms).getUTCHours();
    if (gio < GIO_BAT_DAU || gio >= GIO_KET_THUC) return { ...kq, bo_qua: 'ngoai_gio' };
    dangChay = true;
    try {
      const homNay = vn(ms).toISOString().slice(0, 10);
      const rows = db
        .prepare(
          `SELECT b.id AS bao_cao_id, d.han_nop
             FROM bcp_bao_cao b JOIN bcp_dot d ON d.id = b.dot_id
            WHERE d.trang_thai = 'dang_mo' AND b.trang_thai IN ('chua_nop','can_chinh_sua')`
        )
        .all();
      const giam = db.prepare('INSERT OR IGNORE INTO bcp_nhac_han (bao_cao_id, loai, han_nop) VALUES (?,?,?)');
      const muc = [];
      for (const r of rows) {
        const ngayConLai = Math.round((Date.parse(r.han_nop + 'T00:00:00Z') - Date.parse(homNay + 'T00:00:00Z')) / 86400000);
        const loai = ngayConLai === 0 ? 'hom_nay' : ngayConLai > 0 && ngayConLai <= NHAC_TRUOC_NGAY ? 'truoc_han' : null;
        if (!loai) continue;
        if (giam.run(r.bao_cao_id, loai, r.han_nop).changes === 1) muc.push({ bao_cao_id: r.bao_cao_id, loai, han_nop: r.han_nop });
      }
      if (!muc.length) return kq;
      kq.nhac = muc.length;
      const tk = await thongBao.baoNhacHan(muc, homNay);
      kq.gui = tk.gui;
      if (tk.nguoi_nhan > 0 && tk.gui === 0) {
        // Mọi thư đều hỏng: nhả để lần sau thử lại (nếu một phần đã đi thì giữ, tránh nhắc đôi người đã nhận).
        const nha = db.prepare('DELETE FROM bcp_nhac_han WHERE bao_cao_id = ? AND loai = ? AND han_nop = ?');
        for (const m of muc) nha.run(m.bao_cao_id, m.loai, m.han_nop);
      }
      return kq;
    } catch (e) {
      console.warn('[bao-cao-phong] nhắc hạn lỗi:', e && e.message ? e.message : e);
      return { ...kq, bo_qua: 'loi' };
    } finally {
      dangChay = false;
    }
  }

  /** Đặt lịch chạy định kỳ. Timer không giữ tiến trình sống (unref). Trả hàm dừng. */
  function batDau() {
    const dau = setTimeout(() => chayMotLan(), TRE_BAN_DAU_MS);
    const lap = setInterval(() => chayMotLan(), chuKyMs);
    if (dau.unref) dau.unref();
    if (lap.unref) lap.unref();
    return () => {
      clearTimeout(dau);
      clearInterval(lap);
    };
  }

  return { chayMotLan, batDau };
}

module.exports = { taoNhacHan, GIO_BAT_DAU, GIO_KET_THUC, NHAC_TRUOC_NGAY };
