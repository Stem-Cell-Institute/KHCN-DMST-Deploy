'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — XUẤT một thiết bị ra tệp Excel (.xlsx) và NHẬP lại tệp đó (vòng đi–về, ví dụ chuyển dữ liệu từ máy thử sang máy chính).
 * Router: routes/nganHangTeBaoKhangThe/nhapDuLieu.js. Việc ghi vào CSDL dùng chung với bản nhập Cellseeker (nganHangTeBaoKhangTheNhapCellseeker.thucThi).
 *
 * Phạm vi: thiết bị gốc có dạng «thiết bị → Rack (đánh số vị trí) → hộp (đánh số vị trí) → ống» (bình nitơ lỏng). Thiết bị có ngăn / giá nhiều cấp hoặc hộp
 * không nằm trong Rack thì chưa xuất được (báo rõ lý do).
 *
 * Các trang (sheet): «Hướng dẫn», «Thiết bị», «Rack», «Hộp», «Dòng tế bào», «Lô», «Ống», «QC», «Lịch sử (chỉ đọc)». Khi nhập, tên trang và tiêu đề cột phải giữ nguyên;
 * «Hướng dẫn» và «Lịch sử» bị bỏ qua. Mẫu đã lấy ra khỏi kho (rã đông, hủy) không có trong tệp xuất — chỉ ống đang giữ (đang lưu kho, đã lấy ra tạm).
 * Không có: tệp đính kèm (ảnh, PDF), mật khẩu / tài khoản. Chủ mẫu ghi bằng email; email chưa có tài khoản thì người nhập làm chủ mẫu (có cảnh báo).
 */

const ExcelJS = require('exceljs');
const DT = require('./nganHangTeBaoKhangTheDongTeBao');
const { HOLDING } = require('./nganHangTeBaoKhangThe');

class LoiNguoiDung extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const TRANG_THAI_VN = { in_storage: 'Đang lưu kho', checked_out: 'Đã lấy ra (tạm)' };
const LOAI_CHU_VN = { sinh_vien: 'Sinh viên', nghien_cuu_vien: 'Nghiên cứu viên', can_bo: 'Cán bộ' };
const KIEU_QL_VN = { cellbank: 'Có đơn vị quản lý', cong_khai: 'Public' };
const CO_KHONG = (v) => (v ? 'Có' : 'Không');
const dao = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [String(v).toLowerCase(), k]));
const TRANG_THAI_NGUOC = { ...dao(TRANG_THAI_VN), 'đã lấy ra': 'checked_out' };
const LOAI_CHU_NGUOC = dao(LOAI_CHU_VN);
const KIEU_QL_NGUOC = dao(KIEU_QL_VN);
const LOAI_DONG_NGUOC = dao(DT.LOAI_DONG_VN);
const DANG_NUOI_NGUOC = dao(DT.DANG_NUOI_VN);
const QC_LOAI_NGUOC = dao(DT.QC_LOAI_VN);
const QC_KET_QUA_NGUOC = dao(DT.QC_KET_QUA_VN);

// Cột mỗi trang: [khóa, tiêu đề, độ rộng]
const COT = {
  thietBi: [['ten', 'Tên thiết bị', 30], ['loai', 'Loại thiết bị', 22], ['nhiet_do', 'Nhiệt độ (°C)', 14], ['mau_tb', 'Mã mẫu thiết bị', 16], ['kieu_ql', 'Kiểu quản lý', 20], ['don_vi', 'Đơn vị quản lý', 20], ['ma', 'Mã thiết bị (chỉ đọc)', 20]],
  rack: [['vi_tri', 'Vị trí số', 11], ['ten', 'Tên Rack', 22], ['loai', 'Loại', 14]],
  hop: [['rack', 'Rack (vị trí số)', 15], ['vi_tri', 'Vị trí số', 11], ['ma', 'Mã hộp', 14], ['ten', 'Tên hộp', 22], ['rows', 'Số hàng', 10], ['cols', 'Số cột', 10], ['ghi_chu', 'Ghi chú', 30]],
  dong: [['ma', 'Mã dòng', 16], ['ten', 'Tên dòng', 36], ['loai_sinh_vat', 'Loài', 12], ['mo_nguon_goc', 'Mô nguồn gốc', 20], ['benh', 'Bệnh', 16], ['loai_dong', 'Loại dòng', 18], ['dang_nuoi', 'Dạng nuôi', 12],
    ['moi_truong', 'Môi trường nuôi', 22], ['bo_sung', 'Bổ sung môi trường', 26], ['nhiet_do_c', 'Nhiệt độ nuôi (°C)', 14], ['co2', 'CO₂ (%)', 9], ['nhan_doi', 'Thời gian nhân đôi', 14], ['hinh_thai', 'Hình thái', 20],
    ['tang_truong', 'Đặc điểm tăng trưởng', 22], ['nguon', 'Nguồn cung cấp', 18], ['ma_nguon', 'Mã nguồn / catalog', 16], ['gmo', 'Biến đổi gen', 12], ['gmo_mo_ta', 'Mô tả biến đổi gen', 30], ['bsl', 'BSL', 6],
    ['du_an', 'Đề tài / dự án', 22], ['nhom', 'Nhóm nghiên cứu', 22], ['ghi_chu', 'Ghi chú', 40]],
  lo: [['dong', 'Mã dòng', 16], ['ma', 'Mã lô', 20], ['passage', 'Passage', 10], ['ngay', 'Ngày đông lạnh (YYYY-MM-DD)', 16], ['so_te_bao', 'Số tế bào mỗi ống', 16], ['song_sot', 'Tỉ lệ sống sót (%)', 14], ['moi_truong_dong', 'Môi trường đông lạnh', 22], ['ghi_chu', 'Ghi chú', 40]],
  ong: [['rack', 'Rack (vị trí số)', 15], ['hop', 'Hộp (vị trí số)', 15], ['o', 'Ô (chỉ đọc)', 10], ['row', 'Hàng', 7], ['col', 'Cột', 7], ['ten', 'Tên ống', 34], ['dong', 'Mã dòng', 16], ['lo', 'Mã lô', 20], ['loai_mau', 'Loại mẫu', 14],
    ['passage', 'Passage', 10], ['so_te_bao', 'Số tế bào', 12], ['the_tich', 'Thể tích (mL)', 12], ['ngay', 'Ngày đông lạnh (YYYY-MM-DD)', 16], ['du_an', 'Đề tài', 20], ['trang_thai', 'Trạng thái', 16], ['chu_email', 'Chủ mẫu (email)', 28],
    ['loai_chu', 'Loại chủ mẫu', 16], ['nhom', 'Nhóm nghiên cứu', 20], ['ghi_chu', 'Ghi chú', 30]],
  qc: [['dong', 'Mã dòng', 16], ['lo', 'Mã lô', 20], ['loai', 'Loại kiểm tra', 18], ['ket_qua', 'Kết quả', 12], ['ngay', 'Ngày (YYYY-MM-DD)', 16], ['phuong_phap', 'Phương pháp', 22], ['ghi_chu', 'Ghi chú', 36], ['nguoi', 'Người ghi (chỉ đọc)', 22]],
  lichSu: [['ong', 'Ống (Rack / hộp / ô)', 26], ['at', 'Thời gian (UTC)', 20], ['action', 'Hành động', 18], ['note', 'Chi tiết', 60], ['nguoi', 'Người thực hiện', 24]],
};
const TEN_TRANG = { thietBi: 'Thiết bị', rack: 'Rack', hop: 'Hộp', dong: 'Dòng tế bào', lo: 'Lô', ong: 'Ống', qc: 'QC', lichSu: 'Lịch sử (chỉ đọc)', huongDan: 'Hướng dẫn' };
const HUONG_DAN = [
  'Tệp xuất từ Ngân hàng Tế bào & Kháng thể (STIMS). Nhập lại ở: Quản lý module → Nhập dữ liệu (chỉ Admin).',
  'Giữ nguyên tên các trang và tiêu đề cột. Có thể sửa nội dung ô; không đổi thứ tự hay xóa cột.',
  'Trang «Thiết bị», «Rack», «Hộp», «Ống» bắt buộc; «Dòng tế bào», «Lô», «QC» tùy chọn. Trang «Hướng dẫn» và «Lịch sử (chỉ đọc)» bị bỏ qua khi nhập.',
  'Nhập chỉ THÊM mới: thiết bị, Rack, hộp, dòng, lô, ống đã có (cùng tên / vị trí / mã) thì giữ nguyên, không ghi đè. Nhập lại nhiều lần không bị trùng.',
  'Ống nằm đúng ô theo «Rack», «Hộp», «Hàng», «Cột» (cột «Ô» chỉ để đọc cho dễ). Chủ mẫu ghi bằng email; email chưa có tài khoản thì người nhập làm chủ mẫu.',
  'Không có trong tệp: tệp đính kèm (ảnh, PDF), mẫu đã rã đông / hủy, tài khoản và mật khẩu.',
];

const o = (v) => (v == null || v === '' ? null : v);
const nhanO = (row, col) => String.fromCharCode(64 + row) + col;

// ───────────────────────────── xuất ─────────────────────────────

/** Xuất một thiết bị gốc → {buffer, tenTep, thongKe}. Ném LoiNguoiDung khi thiết bị không có dạng hỗ trợ. */
async function xuatThietBi(db, id) {
  const tb = db
    .prepare('SELECT c.*, t.name AS loai, d.ten AS don_vi_ten FROM nhm_containers c JOIN nhm_container_types t ON t.id = c.type_id LEFT JOIN nhm_don_vi d ON d.id = c.don_vi_id WHERE c.id = ? AND c.deleted_at IS NULL')
    .get(id);
  if (!tb) throw new LoiNguoiDung('Không tìm thấy thiết bị.', 404);
  if (tb.parent_id != null) throw new LoiNguoiDung('Chỉ xuất được thiết bị gốc (bình, tủ), không xuất ngăn hay Rack riêng lẻ.');
  if (tb.ngan_hang !== 'te_bao') throw new LoiNguoiDung('Xuất / nhập Excel hiện chỉ dùng cho thiết bị của ngân hàng tế bào.');
  const rack = db.prepare('SELECT c.*, t.name AS loai_ten FROM nhm_containers c JOIN nhm_container_types t ON t.id = c.type_id WHERE c.parent_id = ? AND c.deleted_at IS NULL ORDER BY COALESCE(c.vi_tri, 999), c.id').all(tb.id);
  if (db.prepare('SELECT 1 FROM nhm_boxes WHERE container_id = ? AND deleted_at IS NULL').get(tb.id)) throw new LoiNguoiDung('Thiết bị này có hộp nằm trực tiếp trong thiết bị (không qua Rack): chưa xuất được. Hiện chỉ hỗ trợ thiết bị dạng bình nitơ (thiết bị → Rack → hộp).');
  for (const r of rack) {
    if (r.loai_ten !== 'Rack') throw new LoiNguoiDung(`«${r.name}» là «${r.loai_ten}», không phải Rack: chưa xuất được. Hiện chỉ hỗ trợ thiết bị dạng bình nitơ (thiết bị → Rack → hộp).`);
    if (r.vi_tri == null) throw new LoiNguoiDung(`«${r.name}» chưa đánh số vị trí: hãy đánh số vị trí cho Rack trước khi xuất.`);
    if (db.prepare('SELECT 1 FROM nhm_containers WHERE parent_id = ? AND deleted_at IS NULL').get(r.id)) throw new LoiNguoiDung(`«${r.name}» còn chứa vị trí lưu trữ con (ngăn / giá nhiều cấp): chưa xuất được. Hiện chỉ hỗ trợ thiết bị dạng bình nitơ (thiết bị → Rack → hộp).`);
  }
  const hop = db
    .prepare('SELECT b.*, r.vi_tri AS rack_vt FROM nhm_boxes b JOIN nhm_containers r ON r.id = b.container_id WHERE r.parent_id = ? AND b.deleted_at IS NULL ORDER BY r.vi_tri, COALESCE(b.vi_tri, 999), b.id')
    .all(tb.id);
  const khongSo = hop.find((b) => b.vi_tri == null);
  if (khongSo) throw new LoiNguoiDung(`Hộp «${khongSo.name || khongSo.code}» chưa đánh số vị trí trong Rack: hãy đánh số vị trí cho hộp trước khi xuất.`);

  const ong = db
    .prepare(
      `SELECT t.*, b.vi_tri AS hop_vt, r.vi_tri AS rack_vt, st.name AS loai_mau, u.email AS chu_email, g.ten AS nhom_ten, l.ma AS lo_ma, d.ma AS dong_ma
       FROM nhm_tubes t JOIN nhm_boxes b ON b.id = t.box_id JOIN nhm_containers r ON r.id = b.container_id
         LEFT JOIN nhm_sample_types st ON st.id = t.sample_type_id LEFT JOIN users u ON u.id = t.owner_user_id LEFT JOIN nhm_nhom g ON g.id = t.nhom_id
         LEFT JOIN nhm_lo l ON l.id = t.lo_id LEFT JOIN nhm_dong_te_bao d ON d.id = l.dong_id
       WHERE r.parent_id = ? AND b.deleted_at IS NULL AND t.deleted_at IS NULL AND t.status IN ${HOLDING}
       ORDER BY r.vi_tri, b.vi_tri, t.row_no, t.col_no`
    )
    .all(tb.id);
  const loIds = [...new Set(ong.map((t) => t.lo_id).filter((x) => x != null))];
  const loRows = loIds.length ? db.prepare(`SELECT l.*, d.ma AS dong_ma FROM nhm_lo l JOIN nhm_dong_te_bao d ON d.id = l.dong_id WHERE l.id IN (${loIds.map(() => '?').join(',')}) AND l.deleted_at IS NULL ORDER BY d.ma, l.ma`).all(...loIds) : [];
  const dongIds = [...new Set(loRows.map((l) => l.dong_id))];
  const dongRows = dongIds.length ? db.prepare(`SELECT d.*, g.ten AS nhom_ten FROM nhm_dong_te_bao d LEFT JOIN nhm_nhom g ON g.id = d.nhom_id WHERE d.id IN (${dongIds.map(() => '?').join(',')}) ORDER BY d.ma`).all(...dongIds) : [];
  const qcRows = dongIds.length
    ? db.prepare(`SELECT q.*, d.ma AS dong_ma, l.ma AS lo_ma FROM nhm_qc q JOIN nhm_dong_te_bao d ON d.id = q.dong_id LEFT JOIN nhm_lo l ON l.id = q.lo_id WHERE q.dong_id IN (${dongIds.map(() => '?').join(',')}) ORDER BY d.ma, q.ngay, q.id`).all(...dongIds)
    : [];
  const lichSu = db
    .prepare(
      `SELECT r.vi_tri AS rack_vt, b.vi_tri AS hop_vt, t.row_no, t.col_no, t.name, m.at, m.action, m.note, m.user_label
       FROM nhm_movements m JOIN nhm_tubes t ON t.id = m.tube_id JOIN nhm_boxes b ON b.id = t.box_id JOIN nhm_containers r ON r.id = b.container_id
       WHERE r.parent_id = ? AND t.deleted_at IS NULL AND t.status IN ${HOLDING} ORDER BY r.vi_tri, b.vi_tri, t.row_no, t.col_no, m.id`
    )
    .all(tb.id);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'STIMS — Ngân hàng Tế bào & Kháng thể';
  wb.created = new Date();
  const hd = wb.addWorksheet(TEN_TRANG.huongDan);
  hd.getColumn(1).width = 120;
  HUONG_DAN.forEach((d, i) => { const c = hd.addRow([d]).getCell(1); c.alignment = { wrapText: true, vertical: 'top' }; if (i === 0) c.font = { bold: true }; });
  const trang = (khoa, rows) => {
    const cot = COT[khoa];
    const ws = wb.addWorksheet(TEN_TRANG[khoa], { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cot.map(([k, h, w]) => ({ header: h, key: k, width: w }));
    rows.forEach((r) => ws.addRow(r));
    const dau = ws.getRow(1);
    dau.font = { bold: true };
    dau.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8ECF4' } };
    dau.alignment = { vertical: 'middle', wrapText: true };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cot.length } };
    return ws;
  };
  trang('thietBi', [{ ten: tb.name, loai: tb.loai, nhiet_do: o(tb.temperature_c), mau_tb: o(tb.mau_tb), kieu_ql: KIEU_QL_VN[tb.quan_ly_boi] || tb.quan_ly_boi, don_vi: o(tb.don_vi_ten), ma: tb.code }]);
  trang('rack', rack.map((r) => ({ vi_tri: r.vi_tri, ten: r.name, loai: r.loai_ten })));
  trang('hop', hop.map((b) => ({ rack: b.rack_vt, vi_tri: b.vi_tri, ma: b.code, ten: o(b.name), rows: b.rows, cols: b.cols, ghi_chu: o(b.notes) })));
  trang('dong', dongRows.map((d) => ({ ma: d.ma, ten: d.ten, loai_sinh_vat: o(d.loai_sinh_vat), mo_nguon_goc: o(d.mo_nguon_goc), benh: o(d.benh), loai_dong: d.loai_dong ? DT.LOAI_DONG_VN[d.loai_dong] : null, dang_nuoi: d.dang_nuoi ? DT.DANG_NUOI_VN[d.dang_nuoi] : null,
    moi_truong: o(d.moi_truong), bo_sung: o(d.bo_sung), nhiet_do_c: o(d.nhiet_do_c), co2: o(d.co2_phan_tram), nhan_doi: o(d.thoi_gian_nhan_doi), hinh_thai: o(d.hinh_thai), tang_truong: o(d.dac_diem_tang_truong), nguon: o(d.nguon_cung_cap), ma_nguon: o(d.ma_nguon),
    gmo: CO_KHONG(d.bien_doi_gen), gmo_mo_ta: o(d.gmo_mo_ta), bsl: o(d.bsl), du_an: o(d.du_an), nhom: o(d.nhom_ten), ghi_chu: o(d.ghi_chu) })));
  trang('lo', loRows.map((l) => ({ dong: l.dong_ma, ma: l.ma, passage: o(l.passage), ngay: o(l.ngay_dong_lanh), so_te_bao: o(l.so_te_bao_moi_ong), song_sot: o(l.ty_le_song_sot), moi_truong_dong: o(l.moi_truong_dong), ghi_chu: o(l.ghi_chu) })));
  trang('ong', ong.map((t) => ({ rack: t.rack_vt, hop: t.hop_vt, o: nhanO(t.row_no, t.col_no), row: t.row_no, col: t.col_no, ten: t.name, dong: o(t.dong_ma), lo: o(t.lo_ma), loai_mau: o(t.loai_mau), passage: o(t.passage), so_te_bao: o(t.cell_count), the_tich: o(t.volume_ml),
    ngay: o(t.freeze_date), du_an: o(t.project), trang_thai: TRANG_THAI_VN[t.status] || t.status, chu_email: o(t.chu_email), loai_chu: t.chu_loai ? LOAI_CHU_VN[t.chu_loai] : null, nhom: o(t.nhom_ten), ghi_chu: o(t.notes) })));
  trang('qc', qcRows.map((q) => ({ dong: q.dong_ma, lo: o(q.lo_ma), loai: DT.QC_LOAI_VN[q.loai], ket_qua: DT.QC_KET_QUA_VN[q.ket_qua], ngay: q.ngay, phuong_phap: o(q.phuong_phap), ghi_chu: o(q.ghi_chu), nguoi: o(q.user_label) })));
  trang('lichSu', lichSu.map((m) => ({ ong: `Rack ${m.rack_vt} / hộp ${m.hop_vt} / ${nhanO(m.row_no, m.col_no)} · ${m.name}`, at: m.at, action: m.action, note: o(m.note), nguoi: o(m.user_label) })));

  const ten = tb.name.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().replace(/\s+/g, '-') || 'thiet-bi';
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, tenTep: `ngan-hang-${ten}-${new Date().toISOString().slice(0, 10)}.xlsx`, thongKe: { rack: rack.length, hop: hop.length, ong: ong.length, dong: dongRows.length, lo: loRows.length, qc: qcRows.length } };
}

// ───────────────────────────── nhập: đọc tệp → kế hoạch ─────────────────────────────

const giaTri = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return giaTri(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((x) => x.text).join('');
    if ('text' in v) return v.text;
    return null;
  }
  return v;
};
const chuoi = (v) => {
  const x = giaTri(v);
  if (x == null) return null;
  const s = (x instanceof Date ? x.toISOString().slice(0, 10) : String(x)).trim();
  return s === '' ? null : s;
};
const so = (v) => {
  const x = giaTri(v);
  if (x == null || String(x).trim() === '') return null;
  const n = typeof x === 'number' ? x : Number(String(x).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
const nguyen = (v) => {
  const n = so(v);
  return n != null && Number.isInteger(n) ? n : n == null ? null : NaN;
};
/** Ngày: Date của Excel, «YYYY-MM-DD» hoặc «DD/MM/YYYY» → «YYYY-MM-DD»; trống → null; sai → undefined. */
const ngay = (v) => {
  const s = chuoi(v);
  if (s == null) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let [y, mo, d] = m ? [m[1], m[2], m[3]] : [];
  if (!m) {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!m) return undefined;
    [d, mo, y] = [m[1], m[2], m[3]];
  }
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return undefined;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
const coKhong = (v) => ['co', 'có', 'yes', 'true', '1', 'x'].includes((chuoi(v) || '').toLowerCase());

/** Đọc một trang thành mảng {khoá: ô, _dong: số dòng}; thiếu trang bắt buộc hoặc thiếu cột thì ném lỗi. */
function docTrang(wb, khoa, batBuoc) {
  const ws = wb.getWorksheet(TEN_TRANG[khoa]);
  if (!ws) {
    if (batBuoc) throw new LoiNguoiDung(`Tệp Excel thiếu trang «${TEN_TRANG[khoa]}». Hãy dùng tệp do chức năng «Xuất Excel» tạo ra và giữ nguyên tên các trang.`);
    return [];
  }
  const dau = new Map();
  ws.getRow(1).eachCell((c, i) => { const t = chuoi(c.value); if (t) dau.set(t.toLowerCase(), i); });
  const cot = COT[khoa].map(([k, h]) => [k, h, dau.get(h.toLowerCase())]);
  const thieu = cot.filter(([k, h, i]) => i == null && !/chỉ đọc/.test(h));
  if (thieu.length) throw new LoiNguoiDung(`Trang «${TEN_TRANG[khoa]}» thiếu cột: ${thieu.map((x) => '«' + x[1] + '»').join(', ')}.`);
  const out = [];
  if (ws.rowCount > 60000) throw new LoiNguoiDung(`Trang «${TEN_TRANG[khoa]}» quá nhiều dòng (${ws.rowCount}).`);
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const x = { _dong: r };
    let coGiaTri = false;
    for (const [k, , i] of cot) {
      x[k] = i != null ? row.getCell(i).value : null;
      if (i != null && chuoi(x[k]) != null) coGiaTri = true;
    }
    if (coGiaTri) out.push(x);
  }
  return out;
}

/** Đọc tệp .xlsx (Buffer) → kế hoạch cho thucThi (cùng dạng với bản Cellseeker). Ném LoiNguoiDung khi tệp sai cấu trúc. */
async function docExcel(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new LoiNguoiDung('Đây không phải tệp Excel (.xlsx). Hãy chọn tệp do chức năng «Xuất Excel» tạo ra.');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (e) {
    throw new LoiNguoiDung('Không mở được tệp Excel (tệp hỏng hoặc không phải .xlsx).');
  }
  const canhBao = [];
  const cb = (s) => canhBao.push(s);
  const dongLoi = (khoa, r, msg) => cb(`Trang «${TEN_TRANG[khoa]}» dòng ${r._dong}: ${msg}`);

  // thiết bị
  const tbRows = docTrang(wb, 'thietBi', true);
  if (tbRows.length !== 1) throw new LoiNguoiDung(`Trang «Thiết bị» phải có đúng 1 dòng (thật: ${tbRows.length}).`);
  const t0 = tbRows[0];
  const ten = chuoi(t0.ten);
  if (!ten) throw new LoiNguoiDung('Trang «Thiết bị»: thiếu tên thiết bị.');
  const nhiet = so(t0.nhiet_do);
  if (Number.isNaN(nhiet)) throw new LoiNguoiDung('Trang «Thiết bị»: nhiệt độ không phải số.');
  const kieu = (chuoi(t0.kieu_ql) || '').toLowerCase();
  const thietBi = { ten: ten.slice(0, 200), loai: chuoi(t0.loai) || 'Bình nitơ lỏng', nhiet_do: nhiet, mau_tb: chuoi(t0.mau_tb), quan_ly_boi: KIEU_QL_NGUOC[kieu] || (kieu === 'cellbank' || kieu === 'cong_khai' ? kieu : 'cellbank'), don_vi_ten: chuoi(t0.don_vi), rack: [] };

  // Rack
  const rackTheoSo = new Map();
  for (const r of docTrang(wb, 'rack', true)) {
    const vt = nguyen(r.vi_tri);
    if (vt == null || Number.isNaN(vt) || vt < 1 || vt > 50) { dongLoi('rack', r, 'vị trí số phải là số nguyên từ 1 đến 50 — bỏ qua.'); continue; }
    if (rackTheoSo.has(vt)) { dongLoi('rack', r, `trùng vị trí số ${vt} — bỏ qua.`); continue; }
    const rk = { nhan: String(vt), vi_tri: vt, ten: chuoi(r.ten), loai: chuoi(r.loai), hop: [] };
    rackTheoSo.set(vt, rk);
    thietBi.rack.push(rk);
  }
  // hộp
  const hopTheo = new Map();
  for (const r of docTrang(wb, 'hop', true)) {
    const rk = nguyen(r.rack), vt = nguyen(r.vi_tri), rows = nguyen(r.rows), cols = nguyen(r.cols);
    if (!rackTheoSo.has(rk)) { dongLoi('hop', r, `Rack «${chuoi(r.rack)}» không có ở trang «Rack» — bỏ qua.`); continue; }
    if (vt == null || Number.isNaN(vt) || vt < 1 || vt > 50 || !(rows >= 1 && rows <= 26) || !(cols >= 1 && cols <= 30)) { dongLoi('hop', r, 'vị trí số (1–50), số hàng (1–26) hoặc số cột (1–30) không hợp lệ — bỏ qua.'); continue; }
    if (hopTheo.has(rk + '|' + vt)) { dongLoi('hop', r, `trùng hộp ở Rack ${rk} vị trí ${vt} — bỏ qua.`); continue; }
    const h = { vi_tri: vt, rows, cols, ma: chuoi(r.ma), ten: chuoi(r.ten), ghi_chu: chuoi(r.ghi_chu) };
    hopTheo.set(rk + '|' + vt, h);
    rackTheoSo.get(rk).hop.push(h);
  }

  // dòng, lô
  const dong = [];
  const dongTheoMa = new Map();
  for (const r of docTrang(wb, 'dong', false)) {
    const ma = chuoi(r.ma);
    if (!ma || !chuoi(r.ten)) { dongLoi('dong', r, 'thiếu mã hoặc tên dòng — bỏ qua.'); continue; }
    if (dongTheoMa.has(ma.toLowerCase())) { dongLoi('dong', r, `trùng mã dòng «${ma}» — bỏ qua.`); continue; }
    const nd = so(r.nhiet_do_c), co2 = so(r.co2), bsl = nguyen(r.bsl);
    const x = {
      cs_id: ma, khop_theo_ma: true, ma: ma.slice(0, 40), ten: chuoi(r.ten).slice(0, 200), loai_sinh_vat: chuoi(r.loai_sinh_vat), mo_nguon_goc: chuoi(r.mo_nguon_goc), benh: chuoi(r.benh),
      loai_dong: LOAI_DONG_NGUOC[(chuoi(r.loai_dong) || '').toLowerCase()] || null, dang_nuoi: DANG_NUOI_NGUOC[(chuoi(r.dang_nuoi) || '').toLowerCase()] || null, moi_truong: chuoi(r.moi_truong), bo_sung: chuoi(r.bo_sung),
      nhiet_do_c: nd != null && !Number.isNaN(nd) ? nd : null, co2_phan_tram: co2 != null && !Number.isNaN(co2) ? co2 : null, thoi_gian_nhan_doi: chuoi(r.nhan_doi), hinh_thai: chuoi(r.hinh_thai), dac_diem_tang_truong: chuoi(r.tang_truong),
      nguon_cung_cap: chuoi(r.nguon), ma_nguon: chuoi(r.ma_nguon), bien_doi_gen: coKhong(r.gmo) ? 1 : 0, gmo_mo_ta: chuoi(r.gmo_mo_ta), bsl: bsl >= 1 && bsl <= 4 ? bsl : null, du_an: chuoi(r.du_an), nhom_ten: chuoi(r.nhom), ghi_chu: chuoi(r.ghi_chu),
    };
    dong.push(x);
    dongTheoMa.set(ma.toLowerCase(), x);
  }
  const lo = [];
  const loTheo = new Map();
  for (const r of docTrang(wb, 'lo', false)) {
    const dg = dongTheoMa.get((chuoi(r.dong) || '').toLowerCase());
    const ma = chuoi(r.ma);
    if (!dg || !ma) { dongLoi('lo', r, `thiếu mã lô hoặc dòng «${chuoi(r.dong) || ''}» không có ở trang «Dòng tế bào» — bỏ qua.`); continue; }
    const khoa = dg.ma.toLowerCase() + '|' + ma.toLowerCase();
    if (loTheo.has(khoa)) { dongLoi('lo', r, `trùng mã lô «${ma}» trong dòng ${dg.ma} — bỏ qua.`); continue; }
    const nl = ngay(r.ngay), sc = so(r.so_te_bao), ss = so(r.song_sot);
    if (nl === undefined) dongLoi('lo', r, 'ngày đông lạnh không đọc được — để trống.');
    const x = { cs_id: dg.cs_id, lot_goc: ma, ma: ma.slice(0, 40), passage: chuoi(r.passage), ngay_dong_lanh: nl || null, so_te_bao_moi_ong: sc != null && !Number.isNaN(sc) ? sc : null, ty_le_song_sot: ss != null && ss >= 0 && ss <= 100 ? ss : null,
      moi_truong_dong: chuoi(r.moi_truong_dong), ghi_chu: chuoi(r.ghi_chu), volume_ml: null, dong: dg };
    lo.push(x);
    loTheo.set(khoa, x);
  }

  // ống
  const ong = [];
  const oDung = new Set();
  for (const r of docTrang(wb, 'ong', true)) {
    const rk = nguyen(r.rack), hp = nguyen(r.hop), row = nguyen(r.row), col = nguyen(r.col);
    const hopKe = hopTheo.get(rk + '|' + hp);
    if (!hopKe) { dongLoi('ong', r, `hộp Rack ${chuoi(r.rack)} / vị trí ${chuoi(r.hop)} không có ở trang «Hộp» — bỏ qua.`); continue; }
    if (!(row >= 1 && row <= hopKe.rows && col >= 1 && col <= hopKe.cols)) { dongLoi('ong', r, `hàng ${chuoi(r.row)} / cột ${chuoi(r.col)} nằm ngoài hộp ${hopKe.rows}×${hopKe.cols} — bỏ qua.`); continue; }
    const khoaO = [rk, hp, row, col].join('|');
    if (oDung.has(khoaO)) { dongLoi('ong', r, `hai ống cùng ô (Rack ${rk}, hộp ${hp}, ${nhanO(row, col)}) — bỏ qua.`); continue; }
    const tenOng = chuoi(r.ten);
    if (!tenOng) { dongLoi('ong', r, 'thiếu tên ống — bỏ qua.'); continue; }
    oDung.add(khoaO);
    let loKe = null;
    if (chuoi(r.lo)) {
      loKe = loTheo.get((chuoi(r.dong) || '').toLowerCase() + '|' + chuoi(r.lo).toLowerCase()) || null;
      if (!loKe) dongLoi('ong', r, `lô «${chuoi(r.lo)}» của dòng «${chuoi(r.dong) || ''}» không có ở trang «Lô» — ống nhập không gắn lô.`);
    }
    const nl = ngay(r.ngay), sc = so(r.so_te_bao), tt = so(r.the_tich);
    if (nl === undefined) dongLoi('ong', r, 'ngày đông lạnh không đọc được — để trống.');
    ong.push({
      tank: thietBi.ten, rack: String(rk), hop: hp, row, col, vi_tri: nhanO(row, col), lo: loKe, ten: tenOng.slice(0, 200), loai_mau: chuoi(r.loai_mau), passage: chuoi(r.passage), cell_count: sc != null && !Number.isNaN(sc) ? sc : null,
      volume_ml: tt != null && !Number.isNaN(tt) ? tt : null, freeze_date: nl || null, project: chuoi(r.du_an), notes: chuoi(r.ghi_chu), trang_thai: TRANG_THAI_NGUOC[(chuoi(r.trang_thai) || '').toLowerCase()] || 'in_storage',
      owner_email: chuoi(r.chu_email), chu_loai: LOAI_CHU_NGUOC[(chuoi(r.loai_chu) || '').toLowerCase()] || null, nhom_ten: chuoi(r.nhom),
    });
  }

  // QC
  const qc = [];
  for (const r of docTrang(wb, 'qc', false)) {
    const dg = dongTheoMa.get((chuoi(r.dong) || '').toLowerCase());
    const loai = QC_LOAI_NGUOC[(chuoi(r.loai) || '').toLowerCase()], kqua = QC_KET_QUA_NGUOC[(chuoi(r.ket_qua) || '').toLowerCase()], nQc = ngay(r.ngay);
    if (!dg || !loai || !kqua || !nQc) { dongLoi('qc', r, 'dòng, loại kiểm tra, kết quả hoặc ngày không hợp lệ — bỏ qua.'); continue; }
    qc.push({ cs_id: dg.cs_id, lo_ma: chuoi(r.lo), loai, ket_qua: kqua, ngay: nQc, phuong_phap: chuoi(r.phuong_phap), ghi_chu: chuoi(r.ghi_chu), nguoi_ghi: chuoi(r.nguoi) });
  }

  return { thietBi: [thietBi], dong, lo, ong, qc, tepLo: [], canhBao, viDu: [], kieuDem: null, ghiChuNhap: 'Nhập từ Excel' };
}

module.exports = { LoiNguoiDung, xuatThietBi, docExcel, COT, TEN_TRANG };
