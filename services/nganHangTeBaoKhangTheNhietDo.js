'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — nhật ký nhiệt độ thiết bị: hàm thuần (không biết req/res).
 * Router: routes/nganHangTeBaoKhangThe/giamSat.js. Bảng nhm_nhiet_do (chỉ thêm), nhm_canh_bao_nhiet.
 *
 * Mỗi thiết bị GỐC có thể bật «theo dõi nhiệt độ»: người dùng ghi số đo (nhiệt độ hiển thị trên tủ, mức nitơ với bình LN) vào nhật ký;
 * số đo ra ngoài khoảng cho phép mở một cảnh báo và báo quản lý ngay. Khoảng cho phép do quản lý đặt; chưa đặt thì dùng gợi ý theo
 * nhiệt độ chuẩn của thiết bị (goiYNguong). Phần mềm chỉ ghi nhận số người ghi vào — chưa nối cảm biến.
 */

const { parseSo } = require('./nganHangTeBaoKhangThe');

const NHIET_TOI_THIEU = -273;
const NHIET_TOI_DA = 100;
const MUC_NITO_TOI_DA = 300; // cm (hoặc đơn vị vạch đo của bình); chỉ giới hạn để chặn gõ nhầm

const lamTron1 = (n) => Math.round(n * 10) / 10;

/**
 * Khoảng nhiệt độ cho phép gợi ý theo nhiệt độ chuẩn của thiết bị: [dưới, trên] hoặc null khi chưa biết nhiệt độ chuẩn.
 * Tủ ấm (≥ 20°C) ±2; tủ lạnh 4°C → 2…8; tủ -20°C ±5; tủ âm sâu (-40…-150) từ chuẩn -10 đến chuẩn +16 (-86°C → -96…-70);
 * dưới -150°C (bình nitơ, tủ -150°C) cảnh báo khi lên quá -150°C.
 */
function goiYNguong(nhietChuan) {
  if (nhietChuan == null || nhietChuan === '' || !Number.isFinite(Number(nhietChuan))) return null;
  const t = Number(nhietChuan);
  if (t >= 20) return [lamTron1(t - 2), lamTron1(t + 2)];
  if (t >= 0) return [lamTron1(t - 2), lamTron1(t + 4)];
  if (t >= -40) return [lamTron1(t - 5), lamTron1(t + 5)];
  if (t > -150) return [lamTron1(t - 10), lamTron1(t + 16)];
  return [lamTron1(t - 20), -150];
}

/** Khoảng đang áp dụng của thiết bị gốc: giá trị quản lý đặt, thiếu phía nào thì lấy gợi ý phía đó. {duoi, tren, tu_dat, goi_y}. */
function nguongHieuLuc(tb) {
  const gy = goiYNguong(tb.temperature_c);
  const duoi = tb.nguong_duoi != null ? Number(tb.nguong_duoi) : gy ? gy[0] : null;
  const tren = tb.nguong_tren != null ? Number(tb.nguong_tren) : gy ? gy[1] : null;
  return { duoi, tren, tu_dat: tb.nguong_duoi != null || tb.nguong_tren != null, goi_y: gy };
}

/** Số đo có nằm ngoài khoảng không (khoảng chưa xác định → không kết luận được, coi là trong khoảng). */
function ngoaiNguong(nhietDo, nguong) {
  if (nguong.duoi != null && nhietDo < nguong.duoi) return true;
  if (nguong.tren != null && nhietDo > nguong.tren) return true;
  return false;
}

/** Đọc số đo từ thân yêu cầu → [{nhiet_do, muc_nito, ghi_chu}, lỗi]. `coNito` = thiết bị là bình nitơ (mức nitơ được ghi). */
function docSoDo(body, coNito) {
  const nd = parseSo(body.nhiet_do, { min: NHIET_TOI_THIEU, max: NHIET_TOI_DA, label: 'Nhiệt độ' });
  if (nd.error) return [null, nd.error];
  if (nd.value == null) return [null, 'Hãy nhập nhiệt độ đang hiển thị trên thiết bị (°C).'];
  let muc = null;
  if (coNito && body.muc_nito != null && body.muc_nito !== '') {
    const m = parseSo(body.muc_nito, { min: 0, max: MUC_NITO_TOI_DA, label: 'Mức nitơ lỏng' });
    if (m.error) return [null, m.error];
    muc = m.value;
  }
  const ghiChu = body.ghi_chu == null ? null : String(body.ghi_chu).trim().slice(0, 500) || null;
  return [{ nhiet_do: nd.value, muc_nito: muc, ghi_chu: ghiChu }, null];
}

/** Đọc cài đặt theo dõi → [{theo_doi, nguong_duoi, nguong_tren}, lỗi]. Ngưỡng trống = dùng gợi ý. */
function docCaiDat(body) {
  const theoDoi = body.theo_doi === true || body.theo_doi === 1 || body.theo_doi === '1';
  const ngu = (k, nhan) => {
    if (body[k] == null || body[k] === '') return { value: null };
    return parseSo(body[k], { min: NHIET_TOI_THIEU, max: NHIET_TOI_DA, label: nhan });
  };
  const d = ngu('nguong_duoi', 'Nhiệt độ thấp nhất cho phép');
  if (d.error) return [null, d.error];
  const t = ngu('nguong_tren', 'Nhiệt độ cao nhất cho phép');
  if (t.error) return [null, t.error];
  if (d.value != null && t.value != null && d.value >= t.value) return [null, 'Nhiệt độ thấp nhất cho phép phải nhỏ hơn nhiệt độ cao nhất.'];
  return [{ theo_doi: theoDoi ? 1 : 0, nguong_duoi: d.value, nguong_tren: t.value }, null];
}

module.exports = { goiYNguong, nguongHieuLuc, ngoaiNguong, docSoDo, docCaiDat, NHIET_TOI_THIEU, NHIET_TOI_DA, MUC_NITO_TOI_DA };
