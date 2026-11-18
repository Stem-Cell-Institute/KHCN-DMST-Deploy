'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — hồ sơ DÒNG TẾ BÀO, lô (stock), QC, tệp đính kèm và báo cáo GMO: hàm thuần (không biết req/res).
 * Router: routes/nganHangTeBaoKhangThe/dongTeBao.js (hồ sơ, lô, QC, báo cáo) và tepDinhKem.js (tệp).
 *
 * Dòng tế bào = thông tin sinh học dùng chung; một dòng có nhiều LÔ đông lạnh; mỗi ống (nhm_tubes.lo_id) thuộc một lô.
 * Dòng biến đổi gen (GMO) bắt buộc mô tả biến đổi và cấp an toàn sinh học (BSL 1–4) để báo cáo được.
 */

const { toStr, toInt, parseSo, parseNgay } = require('./nganHangTeBaoKhangThe');
const { esc } = require('./baoCaoPhongThongBao');
const { layChuKy } = require('./nganHangTeBaoKhangTheNhacViec');

const DANG_NUOI_VN = { bam_dinh: 'Bám dính', huyen_phu: 'Huyền phù', khac: 'Khác' };
const LOAI_DONG_VN = { dong_ban_dau: 'Dòng nguyên phát', dong_vo_han: 'Dòng bất tử hóa', ipsc: 'iPSC', khac: 'Khác' };
const QC_LOAI_VN = { mycoplasma: 'Mycoplasma', str: 'Xác thực STR', song_sot: 'Tỉ lệ sống sót', vi_khuan_nam: 'Vi khuẩn / nấm', hinh_thai: 'Hình thái', khac: 'Khác' };
const QC_KET_QUA_VN = { dat: 'Đạt', khong_dat: 'Không đạt', am_tinh: 'Âm tính', duong_tinh: 'Dương tính', khac: 'Khác' };

// «Quá hạn thử mycoplasma»: quá chu kỳ cấu hình (mặc định 180 ngày) kể từ lần thử gần nhất — xem layChuKy(db).MYCO_NGAY
const BSL_VN = { 1: 'BSL-1', 2: 'BSL-2', 3: 'BSL-3', 4: 'BSL-4' };

const CHUOI = {
  ma: 40, ten: 200, loai_sinh_vat: 100, mo_nguon_goc: 150, benh: 150, moi_truong: 200, bo_sung: 200, thoi_gian_nhan_doi: 60, hinh_thai: 300,
  dac_diem_tang_truong: 300, nguon_cung_cap: 150, ma_nguon: 80, gmo_mo_ta: 1000, du_an: 200, ghi_chu: 2000,
};

/**
 * Đọc thân yêu cầu của dòng tế bào → [giá trị, lỗi]. `tao` = tạo mới (bắt buộc mã và tên). Chỉ trường có trong body mới có trong kết quả
 * (để PATCH không xóa nhầm trường khác); `cur` = dòng hiện có, dùng kiểm tra ràng buộc GMO sau khi gộp.
 */
function docDong(body, { tao, cur }) {
  const out = {};
  let loi = null;
  const them = (e) => { if (!loi) loi = e; };
  for (const k of Object.keys(CHUOI)) if (k in body) out[k] = toStr(body[k], CHUOI[k]);
  if (tao && !out.ma) them('Thiếu mã dòng tế bào.');
  if (tao && !out.ten) them('Thiếu tên dòng tế bào.');
  if ('ma' in out && !out.ma) them('Mã dòng không được để trống.');
  if ('ten' in out && !out.ten) them('Tên dòng không được để trống.');
  if (out.ma && !/^[\p{L}\p{N}][\p{L}\p{N} ._\/-]*$/u.test(out.ma)) them('Mã dòng chỉ gồm chữ, số, dấu cách và . _ / -.');
  const chon = (k, ds, nhan) => {
    if (!(k in body)) return;
    const v = body[k] == null || body[k] === '' ? null : body[k];
    if (v != null && !Object.prototype.hasOwnProperty.call(ds, v)) them(`${nhan} không hợp lệ.`);
    else out[k] = v;
  };
  chon('loai_dong', LOAI_DONG_VN, 'Loại dòng');
  chon('dang_nuoi', DANG_NUOI_VN, 'Dạng nuôi');
  for (const [k, nhan, min, max] of [['nhiet_do_c', 'Nhiệt độ nuôi', 0, 60], ['co2_phan_tram', 'CO₂', 0, 100]]) {
    if (!(k in body)) continue;
    const r = parseSo(body[k], { min, max, label: nhan });
    if (r.error) them(r.error);
    else out[k] = r.value;
  }
  if ('bsl' in body) {
    const v = body.bsl == null || body.bsl === '' ? null : toInt(body.bsl);
    if (v != null && (v < 1 || v > 4)) them('Cấp an toàn sinh học phải từ 1 đến 4.');
    else out.bsl = v;
  }
  if ('bien_doi_gen' in body) {
    const v = body.bien_doi_gen;
    if (!(v === true || v === false || v === 0 || v === 1 || v === '0' || v === '1')) them('Biến đổi gen phải là có hoặc không.');
    else out.bien_doi_gen = v === true || v === 1 || v === '1' ? 1 : 0;
  }
  if ('nhom_id' in body) out.nhom_id = body.nhom_id == null || body.nhom_id === '' ? null : toInt(body.nhom_id);
  // GMO: sau khi gộp với bản hiện có phải có mô tả và cấp an toàn sinh học
  const gop = { ...(cur || {}), ...out };
  if (!loi && gop.bien_doi_gen === 1) {
    if (!gop.gmo_mo_ta) them('Dòng biến đổi gen phải mô tả biến đổi (vector, gen, phương pháp).');
    else if (!gop.bsl) them('Dòng biến đổi gen phải ghi cấp an toàn sinh học (BSL 1–4).');
  }
  return [out, loi];
}

/** Đọc thân yêu cầu của lô → [giá trị, lỗi]. */
function docLo(body, { tao }) {
  const out = {};
  let loi = null;
  const them = (e) => { if (!loi) loi = e; };
  if ('ma' in body) out.ma = toStr(body.ma, 40);
  if (tao && !out.ma) them('Thiếu mã lô.');
  if ('ma' in out && !out.ma) them('Mã lô không được để trống.');
  if ('passage' in body) out.passage = toStr(body.passage, 40);
  if ('moi_truong_dong' in body) out.moi_truong_dong = toStr(body.moi_truong_dong, 200);
  if ('ghi_chu' in body) out.ghi_chu = toStr(body.ghi_chu, 1000);
  if ('ngay_dong_lanh' in body) {
    const r = parseNgay(body.ngay_dong_lanh, 'Ngày đông lạnh');
    if (r.error) them(r.error); else out.ngay_dong_lanh = r.value;
  }
  for (const [k, nhan, min, max] of [['so_te_bao_moi_ong', 'Số tế bào mỗi ống', 0, 1e12], ['ty_le_song_sot', 'Tỉ lệ sống sót (%)', 0, 100]]) {
    if (!(k in body)) continue;
    const r = parseSo(body[k], { min, max, label: nhan });
    if (r.error) them(r.error); else out[k] = r.value;
  }
  return [out, loi];
}

/** Đọc kết quả QC → [giá trị, lỗi]. Ngày không được ở tương lai (so với `homNay` 'YYYY-MM-DD'). */
function docQc(body, homNay) {
  if (!Object.prototype.hasOwnProperty.call(QC_LOAI_VN, body.loai)) return [null, 'Loại kiểm tra QC không hợp lệ.'];
  if (!Object.prototype.hasOwnProperty.call(QC_KET_QUA_VN, body.ket_qua)) return [null, 'Kết quả QC không hợp lệ.'];
  const n = parseNgay(body.ngay, 'Ngày kiểm tra');
  if (n.error) return [null, n.error];
  if (!n.value) return [null, 'Hãy ghi ngày kiểm tra.'];
  if (n.value > homNay) return [null, 'Ngày kiểm tra không được ở tương lai.'];
  if (body.loai === 'mycoplasma' && !['am_tinh', 'duong_tinh'].includes(body.ket_qua)) return [null, 'Kết quả mycoplasma là âm tính hoặc dương tính.'];
  return [{ loai: body.loai, ket_qua: body.ket_qua, ngay: n.value, phuong_phap: toStr(body.phuong_phap, 200), ghi_chu: toStr(body.ghi_chu, 1000) }, null];
}

/** Lần thử mycoplasma gần nhất của dòng: {co, ket_qua, ngay, qua_han}. */
function trangThaiMyco(db, dongId, homNay) {
  const r = db.prepare("SELECT ket_qua, ngay FROM nhm_qc WHERE dong_id = ? AND loai = 'mycoplasma' ORDER BY ngay DESC, id DESC LIMIT 1").get(dongId);
  if (!r) return { co: false, ket_qua: null, ngay: null, qua_han: true };
  const so = (Date.parse(homNay + 'T00:00:00Z') - Date.parse(r.ngay + 'T00:00:00Z')) / 86400000;
  return { co: true, ket_qua: r.ket_qua, ngay: r.ngay, qua_han: so > layChuKy(db).MYCO_NGAY };
}

// ---------- tệp đính kèm: chỉ nhận loại an toàn, nhận dạng theo NỘI DUNG (không tin tên tệp / Content-Type do người dùng gửi) ----------

const TOI_DA_TEP = 10 * 1024 * 1024;
const TOI_DA_TEP_MOI_DOI_TUONG = 20;
const LOAI_TEP = {
  pdf: { mime: 'application/pdf', inline: false },
  png: { mime: 'image/png', inline: true },
  jpg: { mime: 'image/jpeg', inline: true },
  webp: { mime: 'image/webp', inline: true },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false },
  txt: { mime: 'text/plain; charset=utf-8', inline: false },
  csv: { mime: 'text/csv; charset=utf-8', inline: false },
};

/** Loại tệp theo phần mở rộng ĐÃ KHỚP nội dung → 'pdf' | 'png' | ... hoặc null nếu không nhận. */
function nhanDangTep(buf, tenGoc) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(tenGoc || ''));
  let ext = m ? m[1].toLowerCase() : '';
  if (ext === 'jpeg') ext = 'jpg';
  if (!Object.prototype.hasOwnProperty.call(LOAI_TEP, ext)) return null;
  const dau = (s) => buf.subarray(0, s.length).equals(Buffer.from(s, 'latin1'));
  const khop = {
    pdf: () => dau('%PDF-'),
    png: () => buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    jpg: () => buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
    webp: () => dau('RIFF') && buf.subarray(8, 12).toString('latin1') === 'WEBP',
    xlsx: () => buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04,
    docx: () => buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04,
    txt: () => !buf.subarray(0, 8192).includes(0),
    csv: () => !buf.subarray(0, 8192).includes(0),
  }[ext];
  return khop() ? ext : null;
}

/** Tên tệp hiển thị / tải về: bỏ đường dẫn và ký tự điều khiển, tối đa 120 ký tự. */
function lamSachTen(ten) {
  const s = String(ten || 'tep').replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim();
  return (s || 'tep').slice(-120);
}

// ---------- CSV (mở được trong Excel; chống chèn công thức) ----------

/** Một ô CSV: ô bắt đầu bằng = + - @ hoặc tab / xuống dòng được thêm dấu nháy để Excel không chạy như công thức. */
function oCsv(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** rows: mảng đối tượng; cot: [[khóa, tiêu đề]]. Có BOM UTF-8 để Excel đọc đúng tiếng Việt. */
function taoCsv(rows, cot) {
  const dong = [cot.map((c) => oCsv(c[1])).join(',')].concat(rows.map((r) => cot.map((c) => oCsv(r[c[0]])).join(',')));
  return '﻿' + dong.join('\r\n') + '\r\n';
}

// ---------- trang in báo cáo GMO / an toàn sinh học (A4 ngang, tự đủ, mọi chữ người dùng gõ đều được escape) ----------

const ddmmyyyy = (d) => (d ? String(d).split('-').reverse().join('/') : '');

/** d = { dong, tong, loc: {bsl, q}, nguoiIn, ngay, inLuc }. */
function dungBaoCaoGmo(d) {
  const t = d.tong;
  const loc = [d.loc && d.loc.bsl ? 'Cấp an toàn sinh học: BSL-' + d.loc.bsl : '', d.loc && d.loc.q ? 'Từ khóa: ' + d.loc.q : ''].filter(Boolean).join(' · ') || 'Mọi dòng biến đổi gen';
  const hang = d.dong.map((r, i) => `<tr><td>${i + 1}</td><td><b>${esc(r.ma)}</b></td><td>${esc(r.ten)}<br><small>${esc(r.loai_sinh_vat || '')}</small></td><td class="bsl b${r.bsl || 0}">${esc(r.bsl_ten)}</td>
    <td>${esc(r.gmo_mo_ta || '')}</td><td>${esc(r.nguon_cung_cap || '')}</td><td>${esc([r.du_an, r.nhom].filter(Boolean).join(' · '))}</td><td class="so">${r.so_lo}</td><td class="so">${r.so_ong}</td><td>${esc(r.vi_tri || '')}</td><td>${esc(r.mycoplasma)}</td></tr>`).join('');
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Báo cáo dòng tế bào biến đổi gen — an toàn sinh học</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 12px/1.45 'Be Vietnam Pro', Arial, Helvetica, sans-serif; color: #16233d; background: #f3f4f7; }
  .trang { max-width: 1180px; margin: 12px auto; padding: 22px 26px; background: #fff; border: 1px solid #d8dce5; }
  .dau { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #16233d; padding-bottom: 8px; }
  .dau b { display: block; font-size: 14px; } .dau small { color: #4a5873; }
  h1 { margin: 14px 0 2px; font-size: 19px; text-align: center; letter-spacing: .02em; }
  .phu { text-align: center; color: #4a5873; margin: 0 0 10px; }
  .tong { display: flex; gap: 10px; flex-wrap: wrap; margin: 0 0 10px; }
  .tong div { border: 1px solid #c9ceda; padding: 5px 10px; } .tong b { font-size: 15px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 4px 6px; border: 1px solid #c9ceda; text-align: left; vertical-align: top; }
  th { background: #f3f4f7; font-weight: 600; } td small { color: #4a5873; }
  td.so { text-align: right; font-variant-numeric: tabular-nums; }
  td.bsl { font-weight: 700; white-space: nowrap; } td.b3, td.b4 { color: #b7281e; }
  tr { page-break-inside: avoid; }
  .ky { display: flex; gap: 12px; margin-top: 22px; text-align: center; } .ky div { flex: 1; min-height: 80px; } .ky small { display: block; color: #4a5873; }
  .chan { margin-top: 14px; padding-top: 6px; border-top: 1px solid #c9ceda; font-size: 10.5px; color: #4a5873; }
  .nut { position: sticky; top: 0; padding: 10px; text-align: center; background: #16233d; }
  .nut button { padding: 8px 22px; font: inherit; font-weight: 700; cursor: pointer; background: #fff; border: 0; border-radius: 2px; }
  @media print { body { background: #fff; } .trang { margin: 0; max-width: none; border: 0; padding: 0; } .nut { display: none; } }
</style></head><body>
<div class="nut"><button type="button" onclick="window.print()">In báo cáo / lưu PDF</button></div>
<div class="trang">
  <div class="dau"><div><b>Viện Tế bào gốc</b><small>Trường ĐH Khoa học Tự nhiên, ĐHQG TP.HCM</small></div><div style="text-align:right"><b>Ngân hàng Tế bào &amp; Kháng thể</b><small>Hệ thống STIMS</small></div></div>
  <h1>BÁO CÁO DÒNG TẾ BÀO BIẾN ĐỔI GEN — AN TOÀN SINH HỌC</h1>
  <p class="phu">${esc(loc)} · tính đến ${esc(ddmmyyyy(d.ngay))}</p>
  <div class="tong"><div>Số dòng <b>${t.so_dong}</b></div><div>Ống đang giữ <b>${t.so_ong}</b></div><div>BSL-1 <b>${t.theo_bsl[1]}</b></div><div>BSL-2 <b>${t.theo_bsl[2]}</b></div><div>BSL-3 <b>${t.theo_bsl[3]}</b></div><div>BSL-4 <b>${t.theo_bsl[4]}</b></div><div>Chưa thử / quá hạn thử mycoplasma <b>${t.chua_thu_mycoplasma}</b></div></div>
  <table><thead><tr><th>STT</th><th>Mã</th><th>Dòng tế bào</th><th>An toàn sinh học</th><th>Biến đổi gen</th><th>Nguồn cung cấp</th><th>Đề tài · nhóm</th><th>Lô</th><th>Ống</th><th>Vị trí lưu trữ</th><th>Mycoplasma</th></tr></thead>
  <tbody>${hang || '<tr><td colspan="11">Không có dòng biến đổi gen nào khớp bộ lọc.</td></tr>'}</tbody></table>
  <div class="ky"><div><b>Người lập</b><small>(ký, ghi rõ họ tên)</small></div><div><b>Cán bộ an toàn sinh học</b><small>(ký, ghi rõ họ tên)</small></div><div><b>Viện trưởng</b><small>(ký, ghi rõ họ tên)</small></div></div>
  <div class="chan">In lúc ${esc(d.inLuc)} bởi ${esc(d.nguoiIn || '')} từ hệ thống STIMS. Số liệu lấy tại thời điểm in; ống ở thiết bị riêng của người khác không được tính.</div>
</div></body></html>`;
}

module.exports = {
  DANG_NUOI_VN, LOAI_DONG_VN, QC_LOAI_VN, QC_KET_QUA_VN, BSL_VN, TOI_DA_TEP, TOI_DA_TEP_MOI_DOI_TUONG, LOAI_TEP,
  docDong, docLo, docQc, trangThaiMyco, nhanDangTep, lamSachTen, oCsv, taoCsv, dungBaoCaoGmo,
};
