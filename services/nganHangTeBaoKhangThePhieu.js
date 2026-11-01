'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — phiếu yêu cầu lấy mẫu, in được (A4), kèm xác nhận kết quả duyệt.
 * Trả về một trang HTML tự đủ (CSS nằm trong trang, không phụ thuộc tệp ngoài) để người xin mở rồi bấm In / lưu PDF.
 * Mọi dữ liệu người dùng gõ đều được escape. Hàm thuần: không đọc DB, không biết req/res.
 */

const { esc } = require('./baoCaoPhongThongBao');

const TRANG_THAI = {
  cho_duyet: { nhan: 'ĐANG CHỜ DUYỆT', lop: 'cho', ghi: 'Phiếu này CHƯA có giá trị nhận mẫu: chỉ dùng được khi yêu cầu đã được duyệt.' },
  da_duyet: { nhan: 'ĐÃ ĐƯỢC DUYỆT', lop: 'duyet', ghi: 'Chờ quản lý giao mẫu.' },
  da_giao: { nhan: 'ĐÃ ĐƯỢC DUYỆT', lop: 'duyet', ghi: 'Mẫu đã được giao cho người yêu cầu.' },
  da_tra: { nhan: 'ĐÃ ĐƯỢC DUYỆT', lop: 'duyet', ghi: 'Mẫu đã được trả lại kho.' },
  tu_choi: { nhan: 'ĐÃ BỊ TỪ CHỐI', lop: 'tu-choi', ghi: 'Yêu cầu không được chấp thuận; phiếu này không dùng để nhận mẫu.' },
  da_huy: { nhan: 'ĐÃ HỦY', lop: 'tu-choi', ghi: 'Người yêu cầu đã hủy; phiếu này không dùng để nhận mẫu.' },
};

/** 'YYYY-MM-DD HH:MM:SS' (UTC, cách lưu trong DB) → 'HH:MM dd/mm/yyyy' giờ Việt Nam. */
function gioVn(ts) {
  if (!ts) return '—';
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(ts);
  const v = new Date(d.getTime() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(v.getUTCHours())}:${p(v.getUTCMinutes())} ${p(v.getUTCDate())}/${p(v.getUTCMonth() + 1)}/${v.getUTCFullYear()}`;
}

const ten = (u) => (u ? u.fullname || u.email || '(không rõ)' : '—');
const dong = (nhan, giaTri) => `<tr><th>${esc(nhan)}</th><td>${giaTri == null || giaTri === '' ? '—' : esc(giaTri)}</td></tr>`;

/**
 * @param {object} d
 *   yc            dòng nhm_yeu_cau
 *   tube          dòng nhm_tubes (+ loai_mau: tên loại mẫu)
 *   viTri         «Tủ › Ngăn › HOP-0001 › A1»
 *   nguoiGui, nguoiXuLy, chuMau   {fullname, email}
 *   nhomTen       tên nhóm nghiên cứu của mẫu
 *   capTen        tên cấp / đơn vị duyệt («Cellbank», «Chủ mẫu»...)
 *   donViTen      tên đơn vị quản lý thiết bị chứa mẫu (null nếu Public): người ký giao mẫu là «Quản lý <đơn vị>»
 *   xuLyThay      true nếu quản lý xử lý thay người duyệt
 *   inLuc         thời điểm in (chuỗi hiển thị)
 */
function dungPhieu(d) {
  const { yc, tube } = d;
  const tt = TRANG_THAI[yc.trang_thai] || TRANG_THAI.cho_duyet;
  const duyet = tt.lop === 'duyet';
  const so = 'YC-' + String(yc.id).padStart(6, '0');
  const nguoiGiao = d.donViTen ? `Quản lý ${d.donViTen}` : 'Quản lý module';
  const xacNhan = duyet
    ? `<p class="xn">Xác nhận: yêu cầu lấy mẫu nêu trên đã được <b>${esc(d.capTen)}</b> đồng ý bởi <b>${esc(ten(d.nguoiXuLy))}</b>${d.nguoiXuLy && d.nguoiXuLy.email ? ` (${esc(d.nguoiXuLy.email)})` : ''} lúc <b>${esc(gioVn(yc.xu_ly_luc))}</b>${d.xuLyThay ? ` — quản lý xử lý thay người duyệt${yc.ly_do_xu_ly ? ', lý do: ' + esc(yc.ly_do_xu_ly) : ''}` : yc.ly_do_xu_ly ? `. Ghi chú: ${esc(yc.ly_do_xu_ly)}` : ''}.<br>Người nhận mẫu xuất trình phiếu này cho ${esc(nguoiGiao)} khi nhận mẫu.</p>`
    : yc.trang_thai === 'tu_choi'
      ? `<p class="xn">Yêu cầu đã bị từ chối bởi <b>${esc(ten(d.nguoiXuLy))}</b> lúc <b>${esc(gioVn(yc.xu_ly_luc))}</b>. Lý do: ${esc(yc.ly_do_xu_ly || '(không ghi)')}</p>`
      : '';
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phiếu yêu cầu lấy mẫu ${esc(so)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 'Be Vietnam Pro', Arial, Helvetica, sans-serif; color: #16233d; background: #f3f4f7; }
  .trang { max-width: 800px; margin: 16px auto; padding: 28px 34px; background: #fff; border: 1px solid #d8dce5; }
  .dau { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #16233d; padding-bottom: 10px; }
  .dau b { display: block; font-size: 15px; }
  .dau small { color: #4a5873; }
  h1 { margin: 18px 0 2px; font-size: 22px; text-align: center; letter-spacing: .02em; }
  .so { text-align: center; color: #4a5873; margin: 0 0 14px; }
  .ketqua { margin: 0 0 14px; padding: 10px 14px; text-align: center; font-weight: 700; font-size: 17px; letter-spacing: .05em; border: 3px double; }
  .ketqua small { display: block; font-size: 12px; font-weight: 500; letter-spacing: 0; margin-top: 2px; }
  .ketqua.duyet { color: #1e6b3a; border-color: #1e6b3a; }
  .ketqua.tu-choi { color: #b7281e; border-color: #b7281e; }
  .ketqua.cho { color: #8a5a00; border-color: #8a5a00; }
  h2 { margin: 16px 0 6px; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: #4a5873; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 5px 8px; border: 1px solid #c9ceda; text-align: left; vertical-align: top; }
  th { width: 32%; background: #f3f4f7; font-weight: 600; }
  .xn { margin: 12px 0 0; padding: 10px 12px; background: #f3f4f7; border-left: 4px solid #16233d; }
  .ky { display: flex; gap: 12px; margin-top: 26px; text-align: center; }
  .ky div { flex: 1; min-height: 96px; }
  .ky small { display: block; color: #4a5873; }
  .chan { margin-top: 18px; padding-top: 8px; border-top: 1px solid #c9ceda; font-size: 11px; color: #4a5873; }
  .nut { position: sticky; top: 0; padding: 10px; text-align: center; background: #16233d; }
  .nut button { padding: 8px 22px; font: inherit; font-weight: 700; cursor: pointer; background: #fff; border: 0; border-radius: 2px; }
  @media print { body { background: #fff; } .trang { margin: 0; max-width: none; border: 0; padding: 0; } .nut { display: none; } }
</style></head><body>
<div class="nut"><button type="button" onclick="window.print()">In phiếu / lưu PDF</button></div>
<div class="trang">
  <div class="dau"><div><b>Viện Tế bào gốc</b><small>Trường ĐH Khoa học Tự nhiên, ĐHQG TP.HCM</small></div><div style="text-align:right"><b>${esc(d.nganHangTen || 'Ngân hàng tế bào & Kháng thể')}</b><small>Hệ thống STIMS</small></div></div>
  <h1>PHIẾU YÊU CẦU LẤY MẪU</h1>
  <p class="so">Số phiếu: <b>${esc(so)}</b> · gửi lúc ${esc(gioVn(yc.created_at))}</p>
  <div class="ketqua ${tt.lop}">${esc(tt.nhan)}<small>${esc(tt.ghi)}</small></div>
  <h2>Người yêu cầu</h2>
  <table>${dong('Họ tên', ten(d.nguoiGui))}${dong('Email', d.nguoiGui && d.nguoiGui.email)}${dong('Mục đích / lý do', yc.ly_do)}</table>
  <h2>Mẫu được yêu cầu</h2>
  <table>${dong('Tên mẫu', tube.name)}${dong('Loại mẫu', tube.loai_mau)}${dong('Vị trí lưu trữ', d.viTri)}${dong('Chủ mẫu', ten(d.chuMau))}${dong('Nhóm nghiên cứu', d.nhomTen)}${dong('Passage / số tế bào / thể tích', [tube.passage, tube.cell_count, tube.volume_ml != null ? tube.volume_ml + ' mL' : ''].filter((x) => x != null && x !== '').join(' · '))}${dong('Ngày đông lạnh · đề tài', [tube.freeze_date, tube.project].filter(Boolean).join(' · '))}</table>
  <h2>Kết quả xử lý</h2>
  <table>${dong('Cấp duyệt', d.capTen)}${dong('Người xử lý', yc.trang_thai === 'cho_duyet' ? '(chưa xử lý)' : ten(d.nguoiXuLy))}${dong('Thời điểm xử lý', yc.trang_thai === 'cho_duyet' ? '' : gioVn(yc.xu_ly_luc))}</table>
  ${xacNhan}
  <div class="ky"><div><b>Người yêu cầu</b><small>(ký, ghi rõ họ tên)</small></div><div><b>Người duyệt</b><small>(ký, ghi rõ họ tên)</small></div><div><b>${esc(nguoiGiao)} giao mẫu</b><small>(ký, ghi rõ họ tên)</small></div></div>
  <div class="chan">In lúc ${esc(d.inLuc)} từ hệ thống STIMS. Phiếu chỉ có giá trị khi số phiếu <b>${esc(so)}</b> và kết quả khớp với hệ thống.</div>
</div></body></html>`;
}

module.exports = { dungPhieu, gioVn, TRANG_THAI };
