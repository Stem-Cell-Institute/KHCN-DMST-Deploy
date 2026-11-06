'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — NHẬP dữ liệu xuất từ Cellseeker (thư mục giải nén của tệp «cellseeker-export-….zip»).
 * Hàm thuần theo `db`; dòng lệnh: scripts/nhap-cellseeker.js. Test: tests/nganHangTeBaoKhangThe.nhapCellseeker.test.js.
 *
 * Tương ứng:
 *   inventory.csv  (Tank / Rack / Box position / cột / hàng)  → thiết bị gốc «Bình nitơ lỏng» (Cellbank) → Rack (vị trí số) → Hộp (vị trí số)
 *   cells.csv      (dòng tế bào)                               → hồ sơ dòng tế bào (nhm_dong_te_bao)
 *   stocks.csv     (lô / stock)                                → lô (nhm_lo)
 *   vials.csv      (từng ống và vị trí)                        → mẫu (nhm_tubes) trong ô của hộp, kèm dòng «Nhập kho» ở lịch sử
 *   stock-attachments/stock_lot_id-<Lot ID>.<ext>              → tệp đính kèm của lô
 *   (str_profiles.csv không có giá trị lặp nào, vectors.csv rỗng: bỏ qua. cell-images/ không suy ra được dòng nào: bỏ qua và báo.)
 *
 * Nhập lại nhiều lần được (idempotent): dòng tìm theo nhãn «[Cellseeker #id]» ở ghi chú, lô theo (dòng, mã lô), thiết bị theo tên,
 * Rack / hộp theo vị trí số, ống theo ô. Chạy thử (ghi = false) làm hết mọi bước trong một giao dịch rồi HỦY, nên số liệu báo cáo đúng như
 * khi ghi thật, kể cả xung đột. Không bao giờ xóa hay sửa dữ liệu có sẵn.
 *
 * Giả định cần xác nhận với người dùng: «Position» của ống đếm THEO HÀNG, từ trái sang phải, từ trên xuống (ô 1 = A1, ô 6 = B1 với hộp 5 cột).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const DT = require('./nganHangTeBaoKhangTheDongTeBao');
const { HOLDING } = require('./nganHangTeBaoKhangThe');

const NHAN = (id) => `[Cellseeker #${id}]`;

// ───────────────────────────── đọc thư mục xuất ─────────────────────────────

/** Thư mục chứa các tệp *-cells.csv: chính nó hoặc thư mục con duy nhất (cách giải nén .zip thường gặp). */
function timGoc(dir) {
  const co = (d) => fs.readdirSync(d).some((f) => f.endsWith('-cells.csv'));
  if (co(dir)) return dir;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && co(path.join(dir, e.name))) return path.join(dir, e.name);
  }
  throw new Error('Không thấy tệp *-cells.csv trong thư mục này. Hãy trỏ tới thư mục đã giải nén của tệp cellseeker-export-….zip.');
}

function docThuMuc(dir) {
  const goc = timGoc(dir);
  const ds = fs.readdirSync(goc);
  const doc = (hau, batBuoc = true) => {
    const f = ds.find((x) => x.endsWith('-' + hau + '.csv'));
    if (!f) {
      if (batBuoc) throw new Error(`Thiếu tệp *-${hau}.csv trong thư mục xuất.`);
      return [];
    }
    return parse(fs.readFileSync(path.join(goc, f), 'utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true, trim: true });
  };
  const thuMucTep = (ten) => {
    const p = path.join(goc, ten);
    return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => !f.startsWith('.')).map((f) => ({ ten: f, duongDan: path.join(p, f) })) : [];
  };
  return {
    goc,
    cells: doc('cells'),
    stocks: doc('stocks'),
    vials: doc('vials'),
    inventory: doc('inventory'),
    boSungMoiTruong: doc('culture_medium_supplements', false),
    anhDong: thuMucTep('cell-images'),
    tepLo: thuMucTep('stock-attachments'),
  };
}

/**
 * Giải nén tệp .zip (Buffer) vào một thư mục tạm, chỉ lấy tệp cần dùng: các *.csv của Cellseeker và stock-attachments/. Tên tệp lấy phần cuối
 * (không dùng đường dẫn trong zip nên không đi vòng ra ngoài); chặn zip nén quá mức (tổng dung lượng giải nén, số mục).
 * Trả {dir, don()}; người gọi PHẢI gọi don() để xóa thư mục tạm.
 */
function giaiNenZip(buf, gioiHan = {}) {
  const PizZip = require('pizzip');
  const toiDaMuc = gioiHan.toiDaMuc || 3000;
  const toiDaTong = gioiHan.toiDaTong || 300 * 1048576;
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('Đây không phải tệp .zip. Hãy chọn tệp «cellseeker-export-….zip» tải về từ Cellseeker.');
  let zip;
  try {
    zip = new PizZip(buf);
  } catch (e) {
    throw new Error('Không mở được tệp .zip (tệp hỏng?).');
  }
  const muc = Object.values(zip.files).filter((f) => !f.dir);
  if (muc.length > toiDaMuc) throw new Error(`Tệp .zip có quá nhiều mục (${muc.length}).`);
  const tong = muc.reduce((n, f) => n + ((f._data && f._data.uncompressedSize) || 0), 0);
  if (tong > toiDaTong) throw new Error('Tệp .zip giải nén ra quá lớn.');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nhm-cellseeker-'));
  const don = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.join(dir, 'stock-attachments'));
    const daLay = new Set();
    for (const f of muc) {
      const ten = f.name.split(String.fromCharCode(92)).join('/');
      const co = ten.split('/');
      const goc = co[co.length - 1];
      if (!goc || goc.startsWith('.') || co.includes('__MACOSX') || goc.includes(String.fromCharCode(0))) continue;
      const laCsv = /-(cells|stocks|vials|inventory|culture_medium_supplements)\.csv$/.test(goc);
      const laTep = co.length >= 2 && co[co.length - 2] === 'stock-attachments';
      if (!laCsv && !laTep) continue;
      const dich = path.join(dir, laTep ? 'stock-attachments' : '', goc);
      if (daLay.has(dich)) continue;
      daLay.add(dich);
      if (laTep && ((f._data && f._data.uncompressedSize) || 0) > DT.TOI_DA_TEP) continue; // tệp đính kèm quá cỡ: bỏ
      fs.writeFileSync(dich, f.asNodeBuffer());
    }
  } catch (e) {
    don();
    throw e;
  }
  return { dir, don };
}

// ───────────────────────────── lập kế hoạch (thuần, không đụng DB) ─────────────────────────────

const so = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const ngay = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const ngayVn = (iso) => iso.split('-').reverse().join('/');
const cat = (s, n) => String(s == null ? '' : s).slice(0, n);
const LOAI_VN = { Human: 'Người', Mouse: 'Chuột', Deer: 'Hươu', Dog: 'Chó' };

function lapKeHoach(d, opts = {}) {
  const theoCot = opts.kieuDem === 'cot'; // mặc định đếm theo hàng
  const canhBao = [];
  const cb = (s) => canhBao.push(s);

  // ── thiết bị / Rack / hộp ──
  const thietBi = [];
  const tbTheoTen = new Map();
  const hopTheoKhoa = new Map(); // «tank|rack|box» → hộp (kế hoạch)
  for (const r of d.inventory) {
    const ten = r['Tank name'];
    if (!tbTheoTen.has(ten)) { const t = { ten, rack: [] }; tbTheoTen.set(ten, t); thietBi.push(t); }
    const t = tbTheoTen.get(ten);
    const nhanRack = r['Rack label'];
    let rack = t.rack.find((x) => x.nhan === nhanRack);
    if (!rack) {
      let viTri = /^\d+$/.test(nhanRack) ? Number(nhanRack) : null;
      if (viTri == null || viTri < 1 || viTri > 50) { viTri = t.rack.length + 1; cb(`Rack «${nhanRack}» của «${ten}» không phải số 1–50: gán vị trí số ${viTri}.`); }
      rack = { nhan: nhanRack, vi_tri: viTri, hop: [] };
      t.rack.push(rack);
    }
    const viTriHop = Number(r['Box position']);
    const rows = Number(r['Box rows']);
    const cols = Number(r['Box columns']);
    if (!Number.isInteger(viTriHop) || viTriHop < 1 || viTriHop > 50 || !(rows >= 1 && rows <= 26) || !(cols >= 1 && cols <= 30)) { cb(`Bỏ hộp lỗi ở «${ten}» Rack ${nhanRack}: vị trí «${r['Box position']}», ${r['Box rows']}×${r['Box columns']}.`); continue; }
    const hop = { vi_tri: viTriHop, rows, cols };
    rack.hop.push(hop);
    hopTheoKhoa.set([ten, nhanRack, r['Box position']].join('|'), hop);
  }

  // ── dòng tế bào ──
  const boSung = new Map();
  for (const r of d.boSungMoiTruong) {
    const k = r['Cellseeker cell ID'];
    if (!boSung.has(k)) boSung.set(k, []);
    boSung.get(k).push([r.Name, r.Amount && r.Amount + (r.Unit === '%' ? '%' : r.Unit ? ' ' + r.Unit : '')].filter(Boolean).join(' '));
  }
  const dongDaDung = new Set();
  const dong = [];
  const dongTheoId = new Map();
  for (const c of d.cells) {
    const id = c['Cellseeker cell ID'];
    let ma = cat(c['Cell line'].replace(/\s*\(.*$/, '').replace(/[^\p{L}\p{N} ._\/-]/gu, '-').replace(/^[^\p{L}\p{N}]+/u, '').trim(), 40);
    if (!ma) ma = `CS-${id}`;
    if (dongDaDung.has(ma.toLowerCase())) { ma = cat(ma, 34) + '-' + id; cb(`Hai dòng cùng mã rút gọn: dòng #${id} đổi mã thành «${ma}».`); }
    dongDaDung.add(ma.toLowerCase());
    const bsl = /BSL\s*([1-4])/i.exec(c.BSL || '');
    const gmo = String(c.GMO).toLowerCase() === 'true';
    const nhiet = so(c.Temperature);
    const co2 = so(c.CO2);
    const ghiChu = [NHAN(id), c.Description, c['Cultivation comments'] && 'Ghi chú nuôi cấy: ' + c['Cultivation comments'], c['Cellosaurus reference'] && 'Cellosaurus: ' + c['Cellosaurus reference'], c.Clone && 'Clone: ' + c.Clone, c['Freezing medium name'] && 'Môi trường đông lạnh: ' + c['Freezing medium name']]
      .filter(Boolean).join('\n');
    const x = {
      cs_id: id, ma, ten: cat(c['Cell line'], 200), loai_sinh_vat: cat(LOAI_VN[c.Species] || c.Species, 100) || null, mo_nguon_goc: cat(c.Tissue, 150) || null,
      dang_nuoi: { Adherent: 'bam_dinh', Suspension: 'huyen_phu' }[c.Growth] || null, moi_truong: cat(c['Culture medium name'], 200) || null,
      bo_sung: cat((boSung.get(id) || []).join(', '), 200) || null, nhiet_do_c: nhiet != null && nhiet >= 0 && nhiet <= 60 ? nhiet : null,
      co2_phan_tram: co2 != null && co2 >= 0 && co2 <= 100 ? co2 : null, hinh_thai: cat(c.Morphology, 300) || null, nguon_cung_cap: cat(c.Supplier, 150) || null,
      ma_nguon: cat(c['Catalogue number'], 80) || null, bien_doi_gen: gmo ? 1 : 0, bsl: bsl ? Number(bsl[1]) : null, du_an: cat(c.Project, 200) || null,
      freezing_medium: c['Freezing medium name'] || null, ghi_chu: cat(ghiChu, 1900),
    };
    if (gmo) {
      x.gmo_mo_ta = 'Cellseeker ghi dòng này là dòng biến đổi gen nhưng không có mô tả vector / gen. CẦN BỔ SUNG.';
      if (!x.bsl) { x.bsl = 2; cb(`Dòng «${ma}» là GMO nhưng không có cấp BSL: tạm ghi BSL-2, cần xác nhận.`); }
    }
    dong.push(x);
    dongTheoId.set(id, x);
  }

  // ── lô ──
  const lo = [];
  const loTheoKhoa = new Map(); // «cellId|Lot ID» (đúng chữ hoa / thường của Cellseeker) → lô
  const loDaDung = new Set();
  for (const s of d.stocks) {
    const cs = s['Cellseeker cell ID'];
    const dg = dongTheoId.get(cs);
    if (!dg) { cb(`Bỏ lô «${s['Lot ID']}»: dòng Cellseeker #${cs} không có trong cells.csv.`); continue; }
    let ma = cat(s['Lot ID'], 40);
    for (let n = 2; loDaDung.has(cs + '|' + ma.toLowerCase()); n++) ma = cat(s['Lot ID'], 40 - String(n).length - 3) + ` (${n})`;
    if (ma !== cat(s['Lot ID'], 40)) cb(`Lô «${s['Lot ID']}» của dòng ${dg.ma} trùng mã (không phân biệt hoa thường) với lô khác: đổi thành «${ma}».`);
    loDaDung.add(cs + '|' + ma.toLowerCase());
    const dongLanh = ngay(s['Freezing date']);
    const gc = [s.Comments, s['Batch type'] && 'Loại lô (Cellseeker): ' + s['Batch type'], s['Parental stock Lot ID'] && 'Lô gốc: ' + s['Parental stock Lot ID'], s.Operator && 'Người thực hiện: ' + s.Operator,
      so(s.Volume) != null && 'Thể tích: ' + s.Volume + ' mL', String(s['Active status']).toLowerCase() === 'false' && 'Cellseeker đánh dấu lô này không còn hoạt động.',
      ngay(s['Mycoplasma test']) && 'Mycoplasma thử ngày ' + ngayVn(ngay(s['Mycoplasma test'])) + ' (Cellseeker không ghi kết quả).',
      ngay(s['Sterility test']) && 'Vô trùng thử ngày ' + ngayVn(ngay(s['Sterility test'])) + ' (Cellseeker không ghi kết quả).',
      s['Marker tested'] && 'Marker: ' + s['Marker tested']].filter(Boolean).join('\n');
    const aliquot = so(s.Aliquot);
    const viab = so(s.Viability);
    const x = {
      cs_id: cs, lot_goc: s['Lot ID'], ma, passage: cat(s['Passage number'], 40) || null, ngay_dong_lanh: dongLanh, so_te_bao_moi_ong: aliquot != null && aliquot > 0 ? aliquot : null,
      ty_le_song_sot: viab != null && viab >= 0 && viab <= 100 ? viab : null, moi_truong_dong: cat(dg.freezing_medium, 200) || null, ghi_chu: cat(gc, 1900) || null, volume_ml: so(s.Volume), dong: dg,
    };
    lo.push(x);
    loTheoKhoa.set(cs + '|' + s['Lot ID'], x);
  }

  // ── ống ──
  const ong = [];
  const viDu = [];
  const oDaDung = new Set();
  for (const v of d.vials) {
    const l = loTheoKhoa.get(v['Cellseeker cell ID'] + '|' + v['Lot ID']);
    const hop = hopTheoKhoa.get([v['Tank name'], v['Rack label'], v['Box position']].join('|'));
    const vt = Number(v.Position);
    if (!l) { cb(`Bỏ ống ở ${v['Tank name']} R${v['Rack label']} hộp ${v['Box position']} ô ${v.Position}: không có lô «${v['Lot ID']}».`); continue; }
    if (!hop) { cb(`Bỏ ống ${l.dong.ma} ${l.ma}: hộp ${v['Tank name']} R${v['Rack label']} #${v['Box position']} không có trong inventory.csv.`); continue; }
    if (!Number.isInteger(vt) || vt < 1 || vt > hop.rows * hop.cols) { cb(`Bỏ ống ${l.dong.ma} ${l.ma}: ô số ${v.Position} nằm ngoài hộp ${hop.rows}×${hop.cols}.`); continue; }
    const row = theoCot ? ((vt - 1) % hop.rows) + 1 : Math.floor((vt - 1) / hop.cols) + 1;
    const col = theoCot ? Math.floor((vt - 1) / hop.rows) + 1 : ((vt - 1) % hop.cols) + 1;
    const khoaO = [v['Tank name'], v['Rack label'], v['Box position'], row, col].join('|');
    if (oDaDung.has(khoaO)) { cb(`Bỏ ống ${l.dong.ma} ${l.ma}: hai ống cùng ô ${v['Tank name']} R${v['Rack label']} hộp ${v['Box position']} ô ${v.Position}.`); continue; }
    oDaDung.add(khoaO);
    ong.push({ tank: v['Tank name'], rack: v['Rack label'], hop: Number(v['Box position']), row, col, vi_tri: vt, lo: l, freeze_date: ngay(v['Freezing date']) || l.ngay_dong_lanh });
    // vài ví dụ đổi «số ô» của Cellseeker sang tên ô (A1, B2…) để người dùng đối chiếu cách đếm trước khi ghi
    if (viDu.length < 4 && hop.cols > 1 && hop.rows > 1 && vt > 1 && !viDu.some((x) => x.vi_tri === vt && x.rows === hop.rows && x.cols === hop.cols)) {
      viDu.push({ tank: v['Tank name'], rack: v['Rack label'], hop: Number(v['Box position']), vi_tri: vt, rows: hop.rows, cols: hop.cols, o: String.fromCharCode(64 + row) + col, mau: `${l.dong.ma} ${l.ma}` });
    }
  }

  // ── tệp: ảnh của lô khớp theo Lot ID; ảnh dòng không suy ra được dòng nào ──
  const tepLo = [];
  for (const t of d.tepLo) {
    // tên tệp = «stock_lot_id-<Lot ID>[-<hậu tố>].<đuôi>» (vd Lot «HI06-2301.3» → «…HI06-2301.3-CB009.jpg»): lấy lô có mã dài nhất là phần đầu của tên
    const m = /^stock_lot_id-(.+)\.[A-Za-z0-9]+$/.exec(t.ten);
    const tatCa = m ? [...loTheoKhoa.values()].filter((x) => m[1] === x.lot_goc || m[1].startsWith(x.lot_goc + '-')) : [];
    const dai = tatCa.reduce((n, x) => Math.max(n, x.lot_goc.length), 0);
    const l = tatCa.filter((x) => x.lot_goc.length === dai);
    if (l.length !== 1) { cb(`Bỏ tệp «${t.ten}»: ${l.length > 1 ? 'nhiều lô cùng mã' : 'không khớp lô nào'}.`); continue; }
    tepLo.push({ ...t, lo: l[0] });
  }
  if (d.anhDong.length) cb(`${d.anhDong.length} ảnh trong cell-images/ không được nhập: tên «cell_id-<số>-<số>» không cho biết thuộc dòng nào (số đầu không trùng ID dòng trong cells.csv). Đính kèm tay vào hồ sơ dòng nếu cần.`);

  return { thietBi, dong, lo, ong, tepLo, canhBao, viDu, kieuDem: theoCot ? 'cot' : 'hang' };
}

// ───────────────────────────── ghi vào CSDL ─────────────────────────────

class HuyChayThu extends Error {}

/**
 * Thực hiện kế hoạch. opts: { nguoiId, ghi (false = chạy thử rồi hủy), uploadsRoot (bắt buộc khi ghi tệp) }.
 * Trả báo cáo {thietBi, rack, hop, dong, lo, ong, tep: {moi, coSan}, canhBao}.
 */
function thucThi(db, ke, opts) {
  const nguoi = db.prepare('SELECT id, fullname, email FROM users WHERE id = ?').get(opts.nguoiId);
  if (!nguoi) throw new Error('Người nhập không tồn tại (users.id = ' + opts.nguoiId + ').');
  const nhan = nguoi.fullname || nguoi.email;
  const donVi = db.prepare("SELECT id FROM nhm_don_vi WHERE ma = 'cellbank' AND ngan_hang = 'te_bao'").get();
  if (!donVi) throw new Error('Chưa có đơn vị quản lý «Cellbank» của ngân hàng tế bào: chạy server một lần để tạo bảng và dữ liệu mặc định, rồi nhập lại.');
  const kq = { thietBi: { moi: 0, coSan: 0 }, rack: { moi: 0, coSan: 0 }, hop: { moi: 0, coSan: 0 }, dong: { moi: 0, coSan: 0 }, lo: { moi: 0, coSan: 0 }, ong: { moi: 0, coSan: 0, boQua: 0 }, qc: { moi: 0, coSan: 0 }, tep: { moi: 0, coSan: 0, boQua: 0 }, canhBao: ke.canhBao.slice() };

  const layHoacTaoLoai = (ten, nhiet) => {
    const r = db.prepare('SELECT id FROM nhm_container_types WHERE name = ?').get(ten);
    if (r) return r.id;
    return Number(db.prepare('INSERT INTO nhm_container_types (name, default_temp_c, sort_order) VALUES (?, ?, ?)').run(ten, nhiet, 50 + db.prepare('SELECT COUNT(*) AS c FROM nhm_container_types').get().c).lastInsertRowid);
  };
  const nextCode = (bang, tienTo) => {
    let n = db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${bang}`).get().n;
    for (;;) {
      const code = tienTo + String(n).padStart(4, '0');
      if (!db.prepare(`SELECT 1 FROM ${bang} WHERE code = ? AND deleted_at IS NULL`).get(code)) return code;
      n++;
    }
  };
  const loaiMau = db.prepare("SELECT id FROM nhm_sample_types WHERE name = 'Dòng tế bào'").get();

  const idHop = new Map(); // «tank|rack|box» → id hộp trong DB
  const idLo = new Map(); // lô (kế hoạch) → id lô
  const taoTep = [];

  const chay = db.transaction(() => {
    // thiết bị → Rack → hộp
    const loaiRack = layHoacTaoLoai('Rack', null);
    for (const t of ke.thietBi) {
      let tb = db.prepare("SELECT id, quan_ly_boi FROM nhm_containers WHERE parent_id IS NULL AND name = ? AND deleted_at IS NULL AND ngan_hang = 'te_bao'").get(t.ten);
      if (tb) kq.thietBi.coSan++;
      else {
        const nhiet = t.nhiet_do != null ? t.nhiet_do : -196;
        const congKhai = t.quan_ly_boi === 'cong_khai';
        let dv = donVi.id;
        if (!congKhai && t.don_vi_ten) {
          const x = db.prepare("SELECT id FROM nhm_don_vi WHERE LOWER(ten) = LOWER(?) AND ngan_hang = 'te_bao'").get(t.don_vi_ten);
          if (x) dv = x.id;
          else kq.canhBao.push(`Đơn vị quản lý «${t.don_vi_ten}» chưa có trong hệ thống: thiết bị «${t.ten}» tạm gắn với Cellbank.`);
        }
        tb = { quan_ly_boi: congKhai ? 'cong_khai' : 'cellbank', id: Number(db.prepare("INSERT INTO nhm_containers (parent_id, type_id, code, name, temperature_c, quan_ly_boi, don_vi_id, ngan_hang, created_by, mau_tb) VALUES (NULL, ?, ?, ?, ?, ?, ?, 'te_bao', ?, ?)")
          .run(layHoacTaoLoai(t.loai || 'Bình nitơ lỏng', nhiet), nextCode('nhm_containers', 'VC-'), t.ten, nhiet, congKhai ? 'cong_khai' : 'cellbank', congKhai ? null : dv, nguoi.id, t.mau_tb !== undefined ? t.mau_tb : 'binh-ln').lastInsertRowid) };
        kq.thietBi.moi++;
      }
      for (const r of t.rack) {
        let rk = db.prepare('SELECT id FROM nhm_containers WHERE parent_id = ? AND vi_tri = ? AND deleted_at IS NULL').get(tb.id, r.vi_tri);
        if (rk) kq.rack.coSan++;
        else {
          rk = { id: Number(db.prepare("INSERT INTO nhm_containers (parent_id, type_id, code, name, quan_ly_boi, vi_tri, ngan_hang, created_by) VALUES (?, ?, ?, ?, ?, ?, 'te_bao', ?)")
            .run(tb.id, r.loai ? layHoacTaoLoai(r.loai, null) : loaiRack, nextCode('nhm_containers', 'VC-'), r.ten || 'Rack ' + r.vi_tri, tb.quan_ly_boi || 'cellbank', r.vi_tri, nguoi.id).lastInsertRowid) };
          kq.rack.moi++;
        }
        for (const h of r.hop) {
          let hp = db.prepare('SELECT id FROM nhm_boxes WHERE container_id = ? AND vi_tri = ? AND deleted_at IS NULL').get(rk.id, h.vi_tri);
          if (hp) kq.hop.coSan++;
          else {
            let ma = h.ma && !db.prepare('SELECT 1 FROM nhm_boxes WHERE code = ? AND deleted_at IS NULL').get(h.ma) ? h.ma : null;
            if (h.ma && !ma) kq.canhBao.push(`Mã hộp «${h.ma}» đã dùng ở hộp khác: hộp Rack ${r.vi_tri} vị trí ${h.vi_tri} được cấp mã mới.`);
            hp = { id: Number(db.prepare('INSERT INTO nhm_boxes (container_id, template_id, rows, cols, code, name, notes, vi_tri, created_by) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)')
              .run(rk.id, h.rows, h.cols, ma || nextCode('nhm_boxes', 'HOP-'), h.ten || null, h.ghi_chu || null, h.vi_tri, nguoi.id).lastInsertRowid) };
            kq.hop.moi++;
          }
          idHop.set([t.ten, r.nhan, h.vi_tri].join('|'), hp.id);
        }
      }
    }

    // dòng tế bào
    const idDong = new Map();
    for (const dg of ke.dong) {
      let r = dg.khop_theo_ma
        ? db.prepare('SELECT id FROM nhm_dong_te_bao WHERE LOWER(ma) = LOWER(?) AND deleted_at IS NULL').get(dg.ma)
        : db.prepare('SELECT id FROM nhm_dong_te_bao WHERE ghi_chu LIKE ? AND deleted_at IS NULL').get(NHAN(dg.cs_id) + '%');
      if (r) kq.dong.coSan++;
      else {
        let ma = dg.ma;
        if (db.prepare('SELECT 1 FROM nhm_dong_te_bao WHERE LOWER(ma) = LOWER(?) AND deleted_at IS NULL').get(ma)) {
          ma = dg.ma.slice(0, 33) + '-CS' + dg.cs_id;
          kq.canhBao.push(`Mã dòng «${dg.ma}» đã có trong hệ thống (không phải từ Cellseeker): dòng Cellseeker #${dg.cs_id} nhập thành «${ma}».`);
        }
        let nhomId = null;
        if (dg.nhom_ten) {
          const g = db.prepare("SELECT id FROM nhm_nhom WHERE LOWER(ten) = LOWER(?) AND trang_thai <> 'giai_the'").get(dg.nhom_ten);
          if (g) nhomId = g.id;
          else kq.canhBao.push(`Nhóm «${dg.nhom_ten}» của dòng ${dg.ma} chưa có trong hệ thống: bỏ trống nhóm.`);
        }
        r = { id: Number(db.prepare(
          `INSERT INTO nhm_dong_te_bao (ma, ten, loai_sinh_vat, mo_nguon_goc, benh, loai_dong, dang_nuoi, moi_truong, bo_sung, nhiet_do_c, co2_phan_tram, thoi_gian_nhan_doi, hinh_thai, dac_diem_tang_truong,
                                        nguon_cung_cap, ma_nguon, bien_doi_gen, gmo_mo_ta, bsl, du_an, nhom_id, ghi_chu, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(ma, dg.ten, dg.loai_sinh_vat, dg.mo_nguon_goc, dg.benh || null, dg.loai_dong || null, dg.dang_nuoi, dg.moi_truong, dg.bo_sung, dg.nhiet_do_c, dg.co2_phan_tram, dg.thoi_gian_nhan_doi || null, dg.hinh_thai, dg.dac_diem_tang_truong || null,
          dg.nguon_cung_cap, dg.ma_nguon, dg.bien_doi_gen, dg.gmo_mo_ta || null, dg.bsl, dg.du_an, nhomId, dg.ghi_chu, nguoi.id).lastInsertRowid) };
        kq.dong.moi++;
      }
      idDong.set(dg.cs_id, r.id);
    }

    // lô
    for (const l of ke.lo) {
      const dongId = idDong.get(l.cs_id);
      let r = db.prepare('SELECT id FROM nhm_lo WHERE dong_id = ? AND LOWER(ma) = LOWER(?) AND deleted_at IS NULL').get(dongId, l.ma);
      if (r) kq.lo.coSan++;
      else {
        r = { id: Number(db.prepare('INSERT INTO nhm_lo (dong_id, ma, passage, ngay_dong_lanh, so_te_bao_moi_ong, ty_le_song_sot, moi_truong_dong, ghi_chu, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(dongId, l.ma, l.passage, l.ngay_dong_lanh, l.so_te_bao_moi_ong, l.ty_le_song_sot, l.moi_truong_dong, l.ghi_chu, nguoi.id).lastInsertRowid) };
        kq.lo.moi++;
      }
      idLo.set(l, r.id);
    }

    // ống
    const them = db.prepare(
      `INSERT INTO nhm_tubes (box_id, row_no, col_no, sample_type_id, name, passage, cell_count, volume_ml, freeze_date, owner_user_id, project, notes, created_by, chu_loai, nhom_id, chu_don_vi, lo_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    );
    const ls = db.prepare("INSERT INTO nhm_movements (tube_id, action, to_box_id, to_row, to_col, user_id, user_label, note) VALUES (?, 'store', ?, ?, ?, ?, ?, ?)");
    const ghiChuNhap = ke.ghiChuNhap || 'Nhập từ Cellseeker';
    const loaiChu = ['sinh_vien', 'nghien_cuu_vien', 'can_bo'];
    const co = (o, k, mac) => (k in o ? o[k] : mac);
    for (const o of ke.ong) {
      const boxId = idHop.get([o.tank, o.rack, o.hop].join('|'));
      const loId = o.lo ? idLo.get(o.lo) : null;
      const ten = o.ten || cat(`${o.lo.dong.ma} ${o.lo.ma}`, 200);
      const da = db.prepare(`SELECT id, lo_id, name FROM nhm_tubes WHERE box_id = ? AND row_no = ? AND col_no = ? AND deleted_at IS NULL AND status IN ${HOLDING}`).get(boxId, o.row, o.col);
      if (da) {
        if (da.lo_id === loId && da.name === ten) kq.ong.coSan++;
        else { kq.ong.boQua++; kq.canhBao.push(`Ô ${o.tank} R${o.rack} hộp ${o.hop} ô ${o.vi_tri} đã có mẫu khác trong hệ thống: bỏ qua ống «${ten}».`); }
        continue;
      }
      let chuId = nguoi.id;
      if (o.owner_email) {
        const u = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(o.owner_email);
        if (u) chuId = u.id;
        else kq.canhBao.push(`Chủ mẫu «${o.owner_email}» (ống ${ten}) chưa có tài khoản: ghi người nhập làm chủ mẫu.`);
      }
      let nhomId = null;
      if (o.nhom_ten) {
        const g = db.prepare("SELECT id FROM nhm_nhom WHERE LOWER(ten) = LOWER(?) AND trang_thai <> 'giai_the'").get(o.nhom_ten);
        if (g) nhomId = g.id;
      }
      const lm = o.loai_mau ? db.prepare('SELECT id FROM nhm_sample_types WHERE LOWER(name) = LOWER(?)').get(o.loai_mau) : null;
      const id = Number(them.run(boxId, o.row, o.col, lm ? lm.id : loaiMau ? loaiMau.id : null, ten, co(o, 'passage', o.lo && o.lo.passage), co(o, 'cell_count', o.lo && o.lo.so_te_bao_moi_ong), co(o, 'volume_ml', o.lo && o.lo.volume_ml),
        o.freeze_date, chuId, co(o, 'project', o.lo && o.lo.dong.du_an), co(o, 'notes', null), nguoi.id, loaiChu.includes(o.chu_loai) ? o.chu_loai : 'can_bo', nhomId, loId, o.trang_thai === 'checked_out' ? 'checked_out' : 'in_storage').lastInsertRowid);
      ls.run(id, boxId, o.row, o.col, nguoi.id, nhan, ghiChuNhap);
      kq.ong.moi++;
    }

    // kết quả QC của dòng (chỉ thêm, không sửa): đã có kết quả cùng loại, kết quả và ngày thì bỏ qua
    for (const q of ke.qc || []) {
      const dongId = idDong.get(q.cs_id);
      if (!dongId) continue;
      if (db.prepare('SELECT 1 FROM nhm_qc WHERE dong_id = ? AND loai = ? AND ket_qua = ? AND ngay = ?').get(dongId, q.loai, q.ket_qua, q.ngay)) { kq.qc.coSan++; continue; }
      const lo = q.lo_ma ? db.prepare('SELECT id FROM nhm_lo WHERE dong_id = ? AND LOWER(ma) = LOWER(?) AND deleted_at IS NULL').get(dongId, q.lo_ma) : null;
      db.prepare('INSERT INTO nhm_qc (dong_id, lo_id, loai, ket_qua, ngay, phuong_phap, ghi_chu, user_id, user_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(dongId, lo ? lo.id : null, q.loai, q.ket_qua, q.ngay, q.phuong_phap || null, [q.ghi_chu, q.nguoi_ghi && 'Người ghi gốc: ' + q.nguoi_ghi].filter(Boolean).join('\n') || null, nguoi.id, nhan);
      kq.qc.moi++;
    }

    // tệp đính kèm của lô: chỉ lên danh sách; ghi tệp sau khi giao dịch đã chốt
    for (const t of ke.tepLo) taoTep.push({ t, loId: idLo.get(t.lo) });
    if (!opts.ghi) throw new HuyChayThu();
  });

  try {
    chay();
  } catch (e) {
    if (!(e instanceof HuyChayThu)) throw e;
    kq.tep.moi = taoTep.length; // chạy thử: chưa biết trùng hay không, báo số tệp dự kiến
    return kq;
  }

  // ghi tệp (ngoài giao dịch: mỗi tệp một lần, tệp lỗi chỉ báo, không làm hỏng phần đã nhập)
  const goc = path.join(opts.uploadsRoot, 'ngan-hang');
  for (const { t, loId } of taoTep) {
    try {
      const buf = fs.readFileSync(t.duongDan);
      const ten = DT.lamSachTen(t.ten);
      const ext = DT.nhanDangTep(buf, ten);
      if (!ext || buf.length > DT.TOI_DA_TEP) { kq.tep.boQua++; kq.canhBao.push(`Tệp «${ten}» không nhận (loại hoặc cỡ không hợp lệ).`); continue; }
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (db.prepare("SELECT 1 FROM nhm_tep WHERE doi_tuong = 'lo' AND doi_tuong_id = ? AND sha256 = ? AND xoa_luc IS NULL").get(loId, sha)) { kq.tep.coSan++; continue; }
      const nam = String(new Date().getUTCFullYear());
      const khoa = `${nam}/${crypto.randomBytes(16).toString('hex')}`;
      const duongDan = path.join(goc, nam, khoa.split('/')[1]);
      fs.mkdirSync(path.dirname(duongDan), { recursive: true });
      fs.writeFileSync(duongDan, buf, { flag: 'wx' });
      db.prepare('INSERT INTO nhm_tep (doi_tuong, doi_tuong_id, ten_goc, mime, kich_thuoc, khoa, sha256, mo_ta, tao_boi, tao_boi_ten) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('lo', loId, ten, DT.LOAI_TEP[ext].mime, buf.length, khoa, sha, 'Nhập từ Cellseeker', nguoi.id, nhan);
      kq.tep.moi++;
    } catch (e) {
      kq.tep.boQua++;
      kq.canhBao.push(`Tệp «${t.ten}» lỗi: ${e.message}`);
    }
  }
  return kq;
}

module.exports = { docThuMuc, giaiNenZip, lapKeHoach, thucThi, timGoc, NHAN };
