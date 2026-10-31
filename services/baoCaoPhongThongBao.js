/**
 * Thông báo email của module Báo cáo phòng ban.
 *
 * Các sự kiện và người nhận:
 *   phòng nộp / nộp lại báo cáo     → người quản lý module (vai trò quan_ly)
 *   quản lý module TRÌNH / trình lại đợt cho Viện trưởng → Viện trưởng (vai trò vien_truong)
 *   Viện trưởng KHÔNG DUYỆT hoặc ĐỀ NGHỊ CHỈNH SỬA một báo cáo → người phụ trách báo cáo đó + người quản lý module
 *     (Viện trưởng DUYỆT một báo cáo: không gửi thư cho phòng, phòng thấy trạng thái ngay trong báo cáo)
 *   Viện trưởng đã xử lý xong mọi báo cáo chờ quyết định của một đợt → người quản lý module (một thư)
 *   phòng nộp lại đúng báo cáo Viện trưởng đã đề nghị chỉnh sửa → Viện trưởng
 *   Viện trưởng duyệt hồ sơ bằng tệp của cách làm cũ (chỉ còn hồ sơ đang chờ lúc chuyển đổi) → người quản lý module
 *   quản lý MỞ đợt báo cáo           → trưởng phòng của các phòng được giao, kèm liên kết vào đúng báo cáo của phòng họ
 *   Viện trưởng có Ý KIẾN về báo cáo của một phòng → trưởng phòng của CHÍNH phòng đó VÀ người quản lý module (kèm nội dung ý kiến)
 *   hệ thống TỰ nhắc trước hạn nộp (còn 1–2 ngày, và đúng ngày hạn) → trưởng phòng của các phòng CHƯA nộp
 *   quản lý SỬA đợt đang mở (hạn nộp / tiêu đề / hướng dẫn) → trưởng phòng của các phòng CHƯA nộp
 *   quản lý mời / gán trưởng phòng   → người được mời (kèm mã nhận lời mời nếu họ chưa có tài khoản)
 *
 * Viện trưởng chỉ nhận thư khi đợt được trình (hoặc trình lại) và khi một phòng nộp lại đúng báo cáo ông đã đề nghị sửa;
 * KHÔNG nhận thư mỗi lần một phòng nộp: ông ấy ít khi vào module, thư dồn dập sẽ thành rác và làm mất tác dụng của thư quan trọng.
 *
 * Nguyên tắc:
 *   - Email KHÔNG BAO GIỜ làm hỏng thao tác chính. Mọi lỗi (SMTP chưa cấu hình, mạng, địa chỉ hỏng)
 *     chỉ ghi log; hàm trả về kết quả chứ không ném lỗi. Nộp báo cáo thành công dù thư không đi được.
 *   - Gửi RIÊNG từng người, không CC/BCC chung: không lộ địa chỉ của nhau.
 *   - Mọi dữ liệu người dùng gõ (tên phòng, tiêu đề, lời nhắn…) được escape trước khi vào HTML.
 *   - Không gửi cho chính người vừa thực hiện thao tác.
 */

const ChucDanh = require('./baoCaoPhongChucDanh');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNgay(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : s || '';
}

function fmtGio(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const EMAIL_HOP_LE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Biến URL thành liên kết bấm được, CHỈ với URL thuộc chính hệ thống (bắt đầu bằng `goc` = BASE_URL).
 * Không tự biến URL do người dùng gõ (lời nhắn, hướng dẫn đợt…) thành liên kết trong email của hệ thống:
 * đó là cách để người có quyền ghi nội dung gửi liên kết lừa đảo dưới danh nghĩa hệ thống.
 * `daEscape` là chuỗi ĐÃ qua esc(), nên '&' trong URL đã thành '&amp;' — đúng chỗ cho thuộc tính href.
 */
function lienKetHoa(daEscape, goc) {
  if (!goc) return daEscape;
  const gocEsc = esc(goc);
  return daEscape.replace(/https?:\/\/[^\s<]*[^\s<.,;:!?)\]]/g, (url) =>
    url.indexOf(gocEsc) === 0 ? `<a href="${url}" style="color:#b7281e;font-weight:bold">${url}</a>` : url
  );
}

/** Ghép bản text và bản HTML từ cùng một danh sách "đoạn" để hai bản không lệch nhau. */
function dungThu(doan, lienKet, goc) {
  const text = doan.map((d) => (d.nhan ? `${d.nhan}: ${d.text}` : d.text)).join('\n') + (lienKet ? `\n\nMở trong hệ thống: ${lienKet}` : '') + '\n\n— Hệ thống STIMS, Viện Tế bào gốc';
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#16233d">' +
    doan.map((d) => `<p style="margin:0 0 8px">${d.nhan ? `<strong>${esc(d.nhan)}:</strong> ` : ''}${lienKetHoa(esc(d.text), goc).replace(/\n/g, '<br>')}</p>`).join('') +
    (lienKet ? `<p style="margin:14px 0 0"><a href="${esc(lienKet)}" style="color:#b7281e;font-weight:bold">Mở trong hệ thống</a></p>` : '') +
    '<p style="margin:18px 0 0;color:#5a6783;font-size:12px">Hệ thống STIMS, Viện Tế bào gốc — thư tự động, vui lòng không trả lời.</p></div>';
  return { text, html };
}

/**
 * @param {{db:object, mailSend?:(o:{to:string,subject:string,text:string,html:string})=>Promise<any>, baseUrl?:string}} deps
 */
function taoThongBao({ db, mailSend, baseUrl }) {
  const goc = String(baseUrl || '').replace(/\/+$/, '');
  const lienKet = (hash) => (goc ? `${goc}/bao-cao-phong.html${hash}` : '');

  function nguoiNhan(vaiTro, boQuaUserId) {
    return db
      .prepare(
        `SELECT DISTINCT u.id, u.email, u.fullname
           FROM bcp_thanh_vien t JOIN users u ON u.id = t.user_id
          WHERE t.vai_tro = ?`
      )
      .all(vaiTro)
      .filter((u) => u.id !== boQuaUserId && EMAIL_HOP_LE.test(String(u.email || '')));
  }

  /** Gửi lần lượt từng người; trả {gui, loi}. Không bao giờ ném lỗi. */
  async function guiDen(ds, tieuDe, thu) {
    const kq = { gui: 0, loi: 0, nguoi_nhan: ds.length };
    if (!mailSend || !ds.length) return kq;
    for (const u of ds) {
      try {
        await mailSend({ to: u.email, subject: tieuDe, text: thu.text, html: thu.html });
        kq.gui++;
      } catch (e) {
        kq.loi++;
        // Chỉ ghi mã lỗi, không ghi nội dung thư hay địa chỉ đầy đủ vào log.
        console.warn('[bao-cao-phong] Gửi mail thất bại:', e && e.message ? e.message : e);
      }
    }
    return kq;
  }

  /** Tiến độ nộp của một đợt: bao nhiêu phòng đã nộp / cần nộp, và phòng nào chưa. */
  function tienDo(dotId) {
    const rows = db
      .prepare(
        `SELECT b.trang_thai, CASE WHEN u.fullname IS NULL THEN p.ten ELSE p.ten || ' (' || u.fullname || ')' END AS ten
           FROM bcp_bao_cao b JOIN bcp_phong p ON p.id = b.phong_id LEFT JOIN users u ON u.id = b.chu_id WHERE b.dot_id = ? ORDER BY p.ten, u.fullname`
      )
      .all(dotId);
    // Đợt mỗi người một báo cáo thì đếm theo BÁO CÁO (một phòng có thể có nhiều báo cáo); đợt thường vẫn đếm theo phòng.
    const donVi = (db.prepare('SELECT cach_nop FROM bcp_dot WHERE id = ?').get(dotId) || {}).cach_nop === 'tat_ca' ? 'báo cáo' : 'phòng';
    const daNop = rows.filter((r) => r.trang_thai === 'da_nop' || r.trang_thai === 'da_duyet');
    return {
      don_vi: donVi,
      tong: rows.length,
      da_nop: daNop.length,
      cho_duyet: rows.filter((r) => r.trang_thai === 'da_nop').length,
      da_duyet: rows.filter((r) => r.trang_thai === 'da_duyet').length,
      chua_nop: rows.filter((r) => r.trang_thai === 'chua_nop' || r.trang_thai === 'can_chinh_sua').map((r) => r.ten),
    };
  }

  /** Một phòng vừa nộp (hoặc nộp lại) báo cáo. */
  async function baoDaNop(baoCaoId, nguoiNopId, nopLai) {
    const b = db
      .prepare(
        `SELECT b.id, b.dot_id, b.nop_luc, p.ten AS phong_ten, d.tieu_de, d.han_nop, u.fullname AS nguoi_nop
           FROM bcp_bao_cao b
           JOIN bcp_phong p ON p.id = b.phong_id
           JOIN bcp_dot d ON d.id = b.dot_id
           LEFT JOIN users u ON u.id = b.nguoi_nop_id
          WHERE b.id = ?`
      )
      .get(baoCaoId);
    if (!b) return { gui: 0, loi: 0, nguoi_nhan: 0 };
    const td = tienDo(b.dot_id);
    const du = td.tong > 0 && td.da_nop === td.tong;
    const tieuDe = `${du ? '[Đã đủ báo cáo] ' : '[Báo cáo phòng ban] '}${b.phong_ten} ${nopLai ? 'nộp lại' : 'đã nộp'} báo cáo — ${b.tieu_de} (${td.da_nop}/${td.tong} ${td.don_vi})`;
    const doan = [
      { text: `${b.phong_ten} vừa ${nopLai ? 'nộp lại (sau khi chỉnh sửa)' : 'nộp'} báo cáo cho đợt «${b.tieu_de}».` },
      { nhan: 'Người nộp', text: b.nguoi_nop || '(không rõ)' },
      { nhan: 'Thời điểm nộp', text: fmtGio(b.nop_luc) },
      { nhan: 'Hạn nộp của đợt', text: fmtNgay(b.han_nop) },
      { nhan: 'Tiến độ đợt này', text: `đã nộp ${td.da_nop}/${td.tong} ${td.don_vi} (chờ xác nhận ${td.cho_duyet}, đã xác nhận ${td.da_duyet})` },
      { nhan: td.don_vi === 'phòng' ? 'Phòng chưa nộp' : 'Báo cáo chưa nộp', text: td.chua_nop.length ? td.chua_nop.join('; ') : 'không còn — tất cả các phòng đã nộp.' },
    ];
    return guiDen(nguoiNhan('quan_ly', nguoiNopId), tieuDe, dungThu(doan, lienKet(`#/bao-cao/${b.id}`), goc));
  }

  /**
   * Quản lý module TRÌNH (hoặc trình lại để nhắc) một đợt cho Viện trưởng. Không có tệp: Viện trưởng vào module đọc báo cáo của từng phòng
   * và bấm Duyệt / Không duyệt / Ý kiến / Đề nghị chỉnh sửa. Thư nêu số báo cáo đã nộp và phòng nào chưa nộp (để ông biết trước sẽ thấy
   * "Chưa nộp"), KHÔNG nêu số báo cáo đã được người quản lý xác nhận (việc của quản lý, dễ nhầm với việc Viện trưởng duyệt).
   */
  async function baoTrinhVienTruong(dotId, nguoiTrinhId, trinhLai) {
    const d = db.prepare('SELECT id, tieu_de, han_nop FROM bcp_dot WHERE id = ?').get(dotId);
    const t = db.prepare('SELECT loi_nhan, trinh_luc FROM bcp_trinh_lan WHERE dot_id = ? ORDER BY id DESC LIMIT 1').get(dotId);
    if (!d || !t) return { gui: 0, loi: 0, nguoi_nhan: 0 };
    const nguoi = db.prepare('SELECT fullname FROM users WHERE id = ?').get(nguoiTrinhId);
    const td = tienDo(dotId);
    const doan = [
      { text: trinhLai ? `Đợt báo cáo «${d.tieu_de}» được trình lại, đang chờ Viện trưởng xem và quyết định.` : `Đợt báo cáo «${d.tieu_de}» được trình, đang chờ Viện trưởng xem và quyết định.` },
      { nhan: 'Người trình', text: (nguoi && nguoi.fullname) || '(không rõ)' },
      { nhan: 'Thời điểm', text: fmtGio(t.trinh_luc) },
      { nhan: 'Đã nộp', text: `${td.da_nop}/${td.tong} ${td.don_vi}` },
      { nhan: td.don_vi === 'phòng' ? 'Phòng chưa nộp' : 'Báo cáo chưa nộp', text: td.chua_nop.length ? td.chua_nop.join('; ') : 'không còn — tất cả đã nộp.' },
    ];
    if (t.loi_nhan) doan.push({ nhan: 'Lời nhắn', text: t.loi_nhan });
    doan.push({ text: 'Cách làm: đăng nhập eoffice, mở mục "Duyệt báo cáo", đọc báo cáo của từng phòng rồi bấm Duyệt, Không duyệt, Ý kiến hoặc Đề nghị chỉnh sửa. Không cần tải tệp.' });
    const tieuDe = trinhLai ? `[Nhắc duyệt] Báo cáo các phòng — ${d.tieu_de}` : `[Cần duyệt] Báo cáo các phòng — ${d.tieu_de}`;
    return guiDen(nguoiNhan('vien_truong', nguoiTrinhId), tieuDe, dungThu(doan, lienKet(`#/duyet/${d.id}`), goc));
  }

  /** Viện trưởng đã duyệt hồ sơ bằng tệp (cách làm cũ). Chỉ Viện trưởng duyệt được, nên chỉ cần báo người quản lý module. */
  async function baoDaDuyetTrinh(dotId, nguoiDuyetId) {
    const d = db.prepare('SELECT id, tieu_de FROM bcp_dot WHERE id = ?').get(dotId);
    const t = db.prepare('SELECT nhan_xet, duyet_luc FROM bcp_trinh WHERE dot_id = ?').get(dotId);
    if (!d || !t) return { gui: 0, loi: 0, nguoi_nhan: 0 };
    const nguoi = db.prepare('SELECT fullname FROM users WHERE id = ?').get(nguoiDuyetId);
    const ten = (nguoi && nguoi.fullname) || '(không rõ)';
    const doan = [
      { text: `Viện trưởng ${ten} đã duyệt hồ sơ báo cáo của đợt «${d.tieu_de}».` },
      { nhan: 'Thời điểm', text: fmtGio(t.duyet_luc) },
    ];
    if (t.nhan_xet) doan.push({ nhan: 'Nhận xét', text: t.nhan_xet });
    return guiDen(nguoiNhan('quan_ly', nguoiDuyetId), `[Viện trưởng đã duyệt] ${d.tieu_de}`, dungThu(doan, lienKet(`#/dot/${d.id}`), goc));
  }

  const homNayVN = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  function conLaiNgay(hanNop) {
    const n = Math.round((Date.parse(hanNop + 'T00:00:00Z') - Date.parse(homNayVN() + 'T00:00:00Z')) / 86400000);
    if (Number.isNaN(n)) return '';
    if (n > 0) return `còn ${n} ngày`;
    if (n === 0) return 'hết hạn trong hôm nay';
    return `đã quá hạn ${-n} ngày`;
  }

  /**
   * Quản lý MỞ đợt: báo cho trưởng phòng của các phòng được giao, mỗi người MỘT thư (nếu họ phụ trách
   * nhiều phòng thì một thư liệt kê các liên kết), kèm liên kết vào ĐÚNG báo cáo của phòng họ để nộp luôn.
   * Khác các thư khác: KHÔNG loại người vừa mở đợt, vì người quản lý kiêm trưởng phòng vẫn cần thư nhắc việc.
   * `chiPhongIds` (tùy chọn): chỉ báo cho các phòng này — dùng khi thêm phòng vào đợt ĐÃ mở.
   */
  async function baoMoDot(dotId, chiPhongIds) {
    const d = db
      .prepare('SELECT d.id, d.tieu_de, d.mo_ta, d.han_nop, d.ky, m.ten AS mau_ten FROM bcp_dot d JOIN bcp_mau_phien_ban v ON v.id = d.mau_phien_ban_id JOIN bcp_mau m ON m.id = v.mau_id WHERE d.id = ?')
      .get(dotId);
    if (!d) return { gui: 0, loi: 0, nguoi_nhan: 0 };
    let rows = db
      .prepare(
        `SELECT u.id, u.email, u.fullname, b.id AS bao_cao_id, b.phong_id, p.ten AS phong_ten
           FROM bcp_bao_cao b
           JOIN bcp_phong p ON p.id = b.phong_id
           JOIN bcp_thanh_vien t ON t.phong_id = b.phong_id AND t.vai_tro = 'truong_phong' AND (b.chu_id IS NULL OR b.chu_id = t.user_id)
           JOIN users u ON u.id = t.user_id
          WHERE b.dot_id = ? ORDER BY u.id, p.ten`
      )
      .all(dotId);
    if (Array.isArray(chiPhongIds)) rows = rows.filter((r) => chiPhongIds.includes(r.phong_id));
    rows = rows.filter((r) => EMAIL_HOP_LE.test(String(r.email || '')));

    const theoNguoi = new Map();
    for (const r of rows) {
      if (!theoNguoi.has(r.id)) theoNguoi.set(r.id, { email: r.email, ten: r.fullname, phong: [] });
      theoNguoi.get(r.id).phong.push({ id: r.bao_cao_id, ten: r.phong_ten });
    }
    const kq = { gui: 0, loi: 0, nguoi_nhan: theoNguoi.size };
    const han = `${fmtNgay(d.han_nop)} (${conLaiNgay(d.han_nop)})`;
    for (const nguoi of theoNguoi.values()) {
      const nhieu = nguoi.phong.length > 1;
      const doan = [
        { text: `Đợt báo cáo «${d.tieu_de}»${d.ky ? ' (' + d.ky + ')' : ''} vừa được mở. ${nhieu ? 'Các phòng bạn phụ trách' : nguoi.phong[0].ten} cần nộp báo cáo.` },
        { nhan: 'Hạn nộp', text: han },
        { nhan: 'Biểu mẫu', text: d.mau_ten },
      ];
      if (nhieu) doan.push({ nhan: 'Báo cáo cần nộp', text: nguoi.phong.map((p) => `${p.ten}: ${lienKet('#/bao-cao/' + p.id) || '(đăng nhập eoffice → Báo cáo của tôi)'}`).join('\n') });
      doan.push({ text: 'Cách làm: đăng nhập eoffice, mở báo cáo của phòng, điền biểu mẫu rồi bấm "Nộp báo cáo". Bạn có thể lưu nháp và quay lại sau; chỉ khi bấm Nộp thì báo cáo mới được gửi đi.' });
      const lk = nhieu ? lienKet('#/cua-toi') : lienKet('#/bao-cao/' + nguoi.phong[0].id);
      const t = await guiDen([{ email: nguoi.email }], `[Cần nộp báo cáo] ${d.tieu_de} — hạn ${fmtNgay(d.han_nop)}`, dungThu(doan, lk, goc));
      kq.gui += t.gui;
      kq.loi += t.loi;
    }
    return kq;
  }

  /**
   * Người nhận thư "đợt được sửa": trưởng phòng của các phòng CHƯA nộp (chưa nộp hoặc đang cần chỉnh sửa).
   * Phòng đã nộp / đã duyệt không bị làm phiền. Loại người vừa sửa (họ biết rồi). Mỗi người một mục, kèm
   * các báo cáo cần nộp của họ. Tách riêng để route đếm được số người sẽ nhận mà không cần gửi.
   */
  function nguoiNhanSuaDot(dotId, boQuaUserId) {
    const rows = db
      .prepare(
        `SELECT u.id, u.email, u.fullname, b.id AS bao_cao_id, p.ten AS phong_ten
           FROM bcp_bao_cao b
           JOIN bcp_phong p ON p.id = b.phong_id
           JOIN bcp_thanh_vien t ON t.phong_id = b.phong_id AND t.vai_tro = 'truong_phong' AND (b.chu_id IS NULL OR b.chu_id = t.user_id)
           JOIN users u ON u.id = t.user_id
          WHERE b.dot_id = ? AND b.trang_thai IN ('chua_nop','can_chinh_sua') ORDER BY u.id, p.ten`
      )
      .all(dotId)
      .filter((r) => r.id !== boQuaUserId && EMAIL_HOP_LE.test(String(r.email || '')));
    const theoNguoi = new Map();
    for (const r of rows) {
      if (!theoNguoi.has(r.id)) theoNguoi.set(r.id, { email: r.email, ten: r.fullname, phong: [] });
      theoNguoi.get(r.id).phong.push({ id: r.bao_cao_id, ten: r.phong_ten });
    }
    return [...theoNguoi.values()];
  }

  /**
   * Quản lý sửa đợt ĐANG MỞ. `thayDoi` = [{ khoa: 'han_nop'|'tieu_de'|'mo_ta', cu, moi }].
   * Thư nêu rõ giá trị cũ → mới (đặc biệt hạn nộp, vì phòng có thể đang tính theo hạn cũ).
   */
  async function baoSuaDot(dotId, thayDoi, nguoiSuaId) {
    const d = db.prepare('SELECT id, tieu_de, han_nop FROM bcp_dot WHERE id = ?').get(dotId);
    if (!d || !thayDoi || !thayDoi.length) return { gui: 0, loi: 0, nguoi_nhan: 0 };
    const nguoiSua = db.prepare('SELECT fullname FROM users WHERE id = ?').get(nguoiSuaId);
    const doiHan = thayDoi.find((x) => x.khoa === 'han_nop');
    const kq = { gui: 0, loi: 0, nguoi_nhan: 0 };
    const ds = nguoiNhanSuaDot(dotId, nguoiSuaId);
    kq.nguoi_nhan = ds.length;
    for (const nguoi of ds) {
      const nhieu = nguoi.phong.length > 1;
      const doan = [
        { text: `${(nguoiSua && nguoiSua.fullname) || 'Người quản lý module'} vừa cập nhật đợt báo cáo «${d.tieu_de}». ${nhieu ? 'Các phòng bạn phụ trách' : nguoi.phong[0].ten} chưa nộp báo cáo, hãy xem thay đổi dưới đây.` },
      ];
      for (const x of thayDoi) {
        if (x.khoa === 'han_nop') doan.push({ nhan: 'Hạn nộp', text: `${fmtNgay(x.cu)} → ${fmtNgay(x.moi)} (${conLaiNgay(x.moi)})` });
        else if (x.khoa === 'tieu_de') doan.push({ nhan: 'Tiêu đề', text: `«${x.cu}» → «${x.moi}»` });
        else doan.push({ nhan: 'Hướng dẫn của người quản lý', text: 'đã được cập nhật, mở báo cáo của phòng để xem.' });
      }
      if (nhieu) doan.push({ nhan: 'Báo cáo cần nộp', text: nguoi.phong.map((p) => `${p.ten}: ${lienKet('#/bao-cao/' + p.id) || '(đăng nhập eoffice → Báo cáo của tôi)'}`).join('\n') });
      const lk = nhieu ? lienKet('#/cua-toi') : lienKet('#/bao-cao/' + nguoi.phong[0].id);
      const tieuDe = doiHan ? `[Đổi hạn nộp] ${d.tieu_de} — hạn mới ${fmtNgay(d.han_nop)}` : `[Cập nhật đợt báo cáo] ${d.tieu_de}`;
      const t = await guiDen([{ email: nguoi.email }], tieuDe, dungThu(doan, lk, goc));
      kq.gui += t.gui;
      kq.loi += t.loi;
    }
    return kq;
  }

  /** Trưởng phòng của phòng có báo cáo này (người nhận ý kiến của Viện trưởng). */
  function nguoiNhanYKien(baoCaoId) {
    return db
      .prepare(
        `SELECT DISTINCT u.id, u.email, u.fullname
           FROM bcp_bao_cao b
           JOIN bcp_thanh_vien t ON t.phong_id = b.phong_id AND t.vai_tro = 'truong_phong' AND (b.chu_id IS NULL OR b.chu_id = t.user_id)
           JOIN users u ON u.id = t.user_id
          WHERE b.id = ?`
      )
      .all(baoCaoId)
      .filter((u) => EMAIL_HOP_LE.test(String(u.email || '')));
  }

  /**
   * Người quản lý module cũng được báo khi Viện trưởng góp ý (để nắm và phối hợp với phòng). Loại: người vừa viết ý kiến, và
   * người đã nhận với tư cách trưởng phòng (quản lý kiêm trưởng phòng chỉ nhận MỘT thư).
   */
  function nguoiNhanQuanLyYKien(nguoiVietId, daNhan) {
    const trung = new Set((daNhan || []).map((u) => u.id));
    return nguoiNhan('quan_ly', nguoiVietId).filter((u) => !trung.has(u.id));
  }

  /** Viện trưởng vừa gửi ý kiến về báo cáo: gửi nguyên văn cho trưởng phòng của phòng đó và người quản lý module, kèm liên kết vào báo cáo. */
  async function baoYKien(baoCaoId, nguoiVietId, noiDung) {
    const b = db
      .prepare('SELECT b.id, p.ten AS phong_ten, d.tieu_de FROM bcp_bao_cao b JOIN bcp_phong p ON p.id = b.phong_id JOIN bcp_dot d ON d.id = b.dot_id WHERE b.id = ?')
      .get(baoCaoId);
    if (!b) return { gui: 0, loi: 0, nguoi_nhan: 0 };
    const nguoi = db.prepare('SELECT fullname FROM users WHERE id = ?').get(nguoiVietId);
    const ten = (nguoi && nguoi.fullname) || '';
    const doan = [
      { text: `Viện trưởng ${ten} có ý kiến về báo cáo của ${b.phong_ten} trong đợt «${b.tieu_de}».`.replace('  ', ' ') },
      { nhan: 'Ý kiến', text: noiDung },
      { text: 'Bạn có thể xem ý kiến này ngay trong báo cáo của phòng.' },
    ];
    const truongPhong = nguoiNhanYKien(baoCaoId);
    const ds = [...truongPhong, ...nguoiNhanQuanLyYKien(nguoiVietId, truongPhong)];
    return guiDen(ds, `[Ý kiến của Viện trưởng] ${b.phong_ten} — ${b.tieu_de}`, dungThu(doan, lienKet(`#/bao-cao/${b.id}`), goc));
  }

  /**
   * Viện trưởng KHÔNG DUYỆT hoặc ĐỀ NGHỊ CHỈNH SỬA một báo cáo: gửi nguyên văn lý do cho người phụ trách báo cáo đó và người quản lý module.
   * `quyetDinh`: 'khong_duyet' | 'de_nghi_chinh_sua'. `moLaiDot` = đợt vừa được tự mở lại để phòng sửa được.
   */
  async function baoQuyetDinh(baoCaoId, nguoiId, quyetDinh, ghiChu, moLaiDot) {
    const b = db
      .prepare('SELECT b.id, p.ten AS phong_ten, d.tieu_de FROM bcp_bao_cao b JOIN bcp_phong p ON p.id = b.phong_id JOIN bcp_dot d ON d.id = b.dot_id WHERE b.id = ?')
      .get(baoCaoId);
    if (!b) return { gui: 0, loi: 0, nguoi_nhan: 0 };
    const nguoi = db.prepare('SELECT fullname FROM users WHERE id = ?').get(nguoiId);
    const ten = (nguoi && nguoi.fullname) || '';
    const sua = quyetDinh === 'de_nghi_chinh_sua';
    const doan = [
      { text: `Viện trưởng ${ten} ${sua ? 'đề nghị chỉnh sửa' : 'không duyệt'} báo cáo của ${b.phong_ten} trong đợt «${b.tieu_de}».`.replace('  ', ' ') },
      { nhan: sua ? 'Nội dung đề nghị chỉnh sửa' : 'Lý do', text: ghiChu },
    ];
    if (sua) doan.push({ text: 'Báo cáo đã trở về trạng thái "Cần chỉnh sửa". Người phụ trách vui lòng chỉnh sửa rồi nộp lại.' });
    else doan.push({ text: 'Báo cáo vẫn giữ nguyên trạng thái đã nộp. Người phụ trách có thể trao đổi với người quản lý module nếu cần.' });
    if (moLaiDot) doan.push({ text: 'Đợt báo cáo đã được mở lại để phòng chỉnh sửa. Người quản lý module đóng lại đợt khi các phòng đã nộp xong.' });
    const truongPhong = nguoiNhanYKien(baoCaoId);
    const ds = [...truongPhong, ...nguoiNhanQuanLyYKien(nguoiId, truongPhong)];
    const tieuDe = `${sua ? '[Viện trưởng đề nghị chỉnh sửa]' : '[Viện trưởng không duyệt]'} ${b.phong_ten} — ${b.tieu_de}`;
    return guiDen(ds, tieuDe, dungThu(doan, lienKet(`#/bao-cao/${b.id}`), goc));
  }

  /**
   * Viện trưởng đã xử lý xong mọi báo cáo đang chờ quyết định của đợt: MỘT thư cho người quản lý module (không gửi thư cho từng lần Duyệt).
   * `tong` = kết quả của demTienDo (services/baoCaoPhongVienTruong.js).
   */
  async function baoDaXuLyXong(dotId, nguoiId, tong) {
    const d = db.prepare('SELECT id, tieu_de FROM bcp_dot WHERE id = ?').get(dotId);
    if (!d) return { gui: 0, loi: 0, nguoi_nhan: 0 };
    const nguoi = db.prepare('SELECT fullname FROM users WHERE id = ?').get(nguoiId);
    const doan = [{ text: `Viện trưởng ${(nguoi && nguoi.fullname) || ''} đã xử lý xong các báo cáo đã nộp của đợt «${d.tieu_de}».`.replace('  ', ' ') }];
    doan.push({ nhan: 'Kết quả', text: `duyệt ${tong.duyet} · không duyệt ${tong.khong_duyet} · đề nghị chỉnh sửa ${tong.de_nghi_chinh_sua}` });
    const con = tong.chua_nop + tong.dang_sua;
    if (con) doan.push({ nhan: 'Còn lại', text: `${con} báo cáo chưa nộp hoặc đang chỉnh sửa; khi được nộp, báo cáo sẽ lại hiện trong danh sách chờ của Viện trưởng.` });
    return guiDen(nguoiNhan('quan_ly', nguoiId), `[Viện trưởng đã xử lý] ${d.tieu_de}`, dungThu(doan, lienKet(`#/dot/${d.id}`), goc));
  }

  /** Phòng nộp lại báo cáo mà Viện trưởng đã đề nghị chỉnh sửa: báo Viện trưởng để ông xem bản mới (các lần nộp khác không gửi thư cho ông). */
  async function baoNopLaiTheoDeNghi(baoCaoId, nguoiNopId) {
    const b = db
      .prepare('SELECT b.id, b.dot_id, b.nop_luc, p.ten AS phong_ten, d.tieu_de FROM bcp_bao_cao b JOIN bcp_phong p ON p.id = b.phong_id JOIN bcp_dot d ON d.id = b.dot_id WHERE b.id = ?')
      .get(baoCaoId);
    if (!b) return { gui: 0, loi: 0, nguoi_nhan: 0 };
    const nguoi = db.prepare('SELECT fullname FROM users WHERE id = ?').get(nguoiNopId);
    const doan = [
      { text: `${b.phong_ten} đã chỉnh sửa và nộp lại báo cáo theo đề nghị của Viện trưởng, trong đợt «${b.tieu_de}».` },
      { nhan: 'Người nộp', text: (nguoi && nguoi.fullname) || '(không rõ)' },
      { nhan: 'Thời điểm', text: fmtGio(b.nop_luc) },
    ];
    return guiDen(nguoiNhan('vien_truong', nguoiNopId), `[Đã chỉnh sửa theo đề nghị] ${b.phong_ten} — ${b.tieu_de}`, dungThu(doan, lienKet(`#/duyet/${b.dot_id}/${b.id}`), goc));
  }

  /**
   * Nhắc nộp báo cáo. `muc` = [{ bao_cao_id, loai: 'truoc_han'|'hom_nay' }]; `homNay` = 'YYYY-MM-DD' (giờ Việt Nam).
   * Mỗi trưởng phòng MỘT thư dù phụ trách nhiều phòng. Không loại ai (đây là nhắc việc, kể cả quản lý kiêm trưởng
   * phòng cũng cần): người đã nộp được lọc từ trước ở nơi chọn mục cần nhắc.
   */
  async function baoNhacHan(muc, homNay) {
    const kq = { gui: 0, loi: 0, nguoi_nhan: 0 };
    if (!muc || !muc.length) return kq;
    const loaiCua = new Map(muc.map((m) => [m.bao_cao_id, m.loai]));
    const rows = db
      .prepare(
        `SELECT u.id AS user_id, u.email, b.id AS bao_cao_id, b.trang_thai, p.ten AS phong_ten, d.tieu_de, d.han_nop
           FROM bcp_bao_cao b
           JOIN bcp_phong p ON p.id = b.phong_id
           JOIN bcp_dot d ON d.id = b.dot_id
           JOIN bcp_thanh_vien t ON t.phong_id = b.phong_id AND t.vai_tro = 'truong_phong' AND (b.chu_id IS NULL OR b.chu_id = t.user_id)
           JOIN users u ON u.id = t.user_id
          WHERE b.id IN (${muc.map(() => '?').join(',')}) ORDER BY u.id, d.han_nop, p.ten`
      )
      .all(...muc.map((m) => m.bao_cao_id))
      .filter((r) => EMAIL_HOP_LE.test(String(r.email || '')));
    const theoNguoi = new Map();
    for (const r of rows) {
      if (!theoNguoi.has(r.user_id)) theoNguoi.set(r.user_id, { email: r.email, muc: [] });
      theoNguoi.get(r.user_id).muc.push(r);
    }
    kq.nguoi_nhan = theoNguoi.size;
    const ngayConLai = (han) => Math.round((Date.parse(han + 'T00:00:00Z') - Date.parse(homNay + 'T00:00:00Z')) / 86400000);
    const cum = (han) => {
      const n = ngayConLai(han);
      return n > 0 ? `còn ${n} ngày` : n === 0 ? 'hết hạn trong hôm nay' : `đã quá hạn ${-n} ngày`;
    };
    for (const nguoi of theoNguoi.values()) {
      const homNayCo = nguoi.muc.some((m) => loaiCua.get(m.bao_cao_id) === 'hom_nay');
      const nhieu = nguoi.muc.length > 1;
      const m0 = nguoi.muc[0];
      const doan = [];
      if (!nhieu) {
        doan.push({ text: `${m0.phong_ten} chưa nộp báo cáo của đợt «${m0.tieu_de}».` });
        doan.push({ nhan: 'Hạn nộp', text: `${fmtNgay(m0.han_nop)} (${cum(m0.han_nop)})` });
        if (m0.trang_thai === 'can_chinh_sua') doan.push({ text: 'Báo cáo đang cần chỉnh sửa theo yêu cầu của người quản lý, bạn cần sửa rồi nộp lại.' });
      } else {
        doan.push({ text: `Bạn có ${nguoi.muc.length} báo cáo chưa nộp sắp đến hạn:` });
        doan.push({ text: nguoi.muc.map((m) => `• ${m.phong_ten} — «${m.tieu_de}», hạn ${fmtNgay(m.han_nop)} (${cum(m.han_nop)})${goc ? ': ' + lienKet('#/bao-cao/' + m.bao_cao_id) : ''}`).join('\n') });
      }
      doan.push({ text: 'Cách làm: đăng nhập eoffice, mở báo cáo của phòng, điền biểu mẫu rồi bấm "Nộp báo cáo". Bạn có thể lưu nháp và quay lại sau.' });
      const lk = nhieu ? lienKet('#/cua-toi') : lienKet('#/bao-cao/' + m0.bao_cao_id);
      const tieuDe = homNayCo
        ? `[Hạn nộp hôm nay] ${nhieu ? nguoi.muc.length + ' báo cáo chưa nộp' : m0.tieu_de}`
        : `[Nhắc nộp báo cáo] ${nhieu ? nguoi.muc.length + ' báo cáo sắp đến hạn' : m0.tieu_de + ' — ' + cum(m0.han_nop) + ' (hạn ' + fmtNgay(m0.han_nop) + ')'}`;
      const t = await guiDen([{ email: nguoi.email }], tieuDe, dungThu(doan, lk, goc));
      kq.gui += t.gui;
      kq.loi += t.loi;
    }
    return kq;
  }

  /**
   * Mời một email CHƯA có tài khoản làm trưởng phòng. Thư chứa MÃ DÙNG MỘT LẦN: đó là bằng chứng người
   * nhận đọc được hộp thư này (đăng ký tài khoản của hệ thống không xác minh email — xem baoCaoPhongSchema.js).
   */
  async function baoLoiMoi({ email, phongTen, nguoiMoiTen, ma, hetHan, chucDanh }) {
    const cd = ChucDanh.nhan(chucDanh);
    const doan = [
      { text: `${nguoiMoiTen || 'Người quản lý module'} mời ${cd} — ${phongTen} vào module Báo cáo phòng ban của hệ thống eoffice (STIMS), để nộp báo cáo của phòng.` },
      { text: 'Địa chỉ email này CHƯA có tài khoản eoffice. Hãy làm theo 3 bước:' },
      { nhan: 'Bước 1', text: `Đăng ký tài khoản tại ${goc ? goc + '/dang-ky.html' : 'trang Đăng ký của eoffice'} bằng CHÍNH địa chỉ email này (${email}).` },
      { nhan: 'Bước 2', text: `Đăng nhập, rồi mở ${goc ? goc + '/bao-cao-phong.html' : 'module Báo cáo phòng ban'}.` },
      { nhan: 'Bước 3', text: `Nhập mã lời mời: ${ma}` },
      { text: `Mã chỉ dùng được MỘT lần và có hiệu lực đến ${fmtNgay(String(hetHan).slice(0, 10))}. Mã chỉ có tác dụng với tài khoản đăng nhập bằng đúng địa chỉ email này. Nếu bạn không biết lời mời này, hãy bỏ qua thư.` },
    ];
    const lk = goc ? `${goc}/bao-cao-phong.html?moi=${ma}` : '';
    return guiDen([{ email }], `[Báo cáo phòng ban] Mời ${cd} — ${phongTen} vào module Báo cáo phòng ban`, dungThu(doan, lk, goc));
  }

  /** Người ĐÃ có tài khoản được gán làm trưởng phòng: báo cho họ, kèm các đợt đang mở của phòng đó. */
  async function baoDuocGan(userId, phongId, nguoiMoiId, chucDanh) {
    const cd = ChucDanh.nhan(chucDanh);
    const u = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(userId);
    const p = db.prepare('SELECT ten FROM bcp_phong WHERE id = ?').get(phongId);
    if (!u || !p || !EMAIL_HOP_LE.test(String(u.email || ''))) return { gui: 0, loi: 0, nguoi_nhan: 0 };
    const moi = db.prepare('SELECT fullname FROM users WHERE id = ?').get(nguoiMoiId);
    const dangMo = db
      .prepare(
        `SELECT b.id, d.tieu_de, d.han_nop FROM bcp_bao_cao b JOIN bcp_dot d ON d.id = b.dot_id
          WHERE b.phong_id = ? AND (b.chu_id IS NULL OR b.chu_id = ?) AND d.trang_thai = 'dang_mo' AND b.trang_thai IN ('chua_nop','can_chinh_sua') ORDER BY d.han_nop`
      )
      .all(phongId, userId);
    const doan = [{ text: `${(moi && moi.fullname) || 'Người quản lý module'} đã thêm ${cd} — ${p.ten} vào module Báo cáo phòng ban của hệ thống eoffice. Bạn sẽ nộp báo cáo của phòng tại đây.` }];
    if (dangMo.length) {
      doan.push({ nhan: 'Đang có báo cáo cần nộp', text: dangMo.map((x) => `${x.tieu_de} — hạn ${fmtNgay(x.han_nop)} (${conLaiNgay(x.han_nop)})${goc ? ': ' + lienKet('#/bao-cao/' + x.id) : ''}`).join('\n') });
    }
    return guiDen([{ email: u.email }], `[Báo cáo phòng ban] ${cd} — ${p.ten}: bạn đã được thêm vào module`, dungThu(doan, lienKet('#/cua-toi'), goc));
  }

  /** Viện trưởng sẽ nhận thư (có email hợp lệ), trừ `boQuaUserId`. Tách riêng để route đếm được số người nhận mà không cần gửi. */
  const nguoiNhanVienTruong = (boQuaUserId) => nguoiNhan('vien_truong', boQuaUserId);

  return { nguoiNhanVienTruong, baoDaNop, baoTrinhVienTruong, baoDaDuyetTrinh, baoQuyetDinh, baoDaXuLyXong, baoNopLaiTheoDeNghi, baoMoDot, baoSuaDot, nguoiNhanSuaDot, baoNhacHan, nguoiNhanYKien, nguoiNhanQuanLyYKien, baoYKien, baoLoiMoi, baoDuocGan, tienDo };
}

module.exports = { taoThongBao, esc };
